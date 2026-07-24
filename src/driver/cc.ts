/**
 * CC driver(批2):claude CLI headless 实现。
 *
 * spawn `claude -p --output-format stream-json --verbose` 子进程,逐行解析 → DriverEvent。
 * 架构红线:不直连大模型,所有流量经 claude CLI(复用用户认证 / GLM 网关,继承 env)。
 *
 * stream-json 事件(2026-06-23 PoC 确认,claude 2.1.185):
 *   system/init → init · assistant.content[text|tool_use] → text|tool_use
 *   user.content[tool_result] → tool_result · result → done
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { splitFrontMatter } from '../format/frontmatter.js'
import type {
  Session,
  SessionOptions,
  ApprovalResponse,
  DriverEvent,
  StudioDriver,
} from './types.js'

/** 每 session 一个事件总线(子进程 stdout 解析后 push,stream 排空) */
interface Channel {
  events: DriverEvent[]
  waiters: Array<() => void>
  /** 本次 spawn 是否已推过终止事件(done/error);close 时据此补推,防 SSE 收不到终止信号 */
  terminated?: boolean
}
const channels = new Map<string, Channel>()
const sessions = new Map<string, Session>()
/** session → claude 子进程(dispose 时 kill 防僵尸,Opus P1) */
const sessionChild = new Map<string, ChildProcess>()
let sessionSeq = 0

function channel(id: string): Channel {
  let ch = channels.get(id)
  if (!ch) {
    ch = { events: [], waiters: [] }
    channels.set(id, ch)
  }
  return ch
}

function push(id: string, ev: DriverEvent): void {
  const ch = channel(id)
  ch.events.push(ev)
  if (ev.type === 'done' || ev.type === 'error') ch.terminated = true
  for (const w of ch.waiters) w()
  ch.waiters = []
}

/** 读角色系统提示(.claude/agents/<role>.md 去 frontmatter 后正文) */
function readRolePrompt(cwd: string, role: string): string {
  const fp = join(cwd, '.claude', 'agents', `${role}.md`)
  if (!existsSync(fp)) return ''
  let raw = ''
  try {
    raw = readFileSync(fp, 'utf8')
  } catch {
    return ''
  }
  // renderClaudeAgent 格式:--- frontmatter --- 正文;取正文作系统提示
  const split = splitFrontMatter(raw)
  return split === null ? raw.trim() : split.body.trim()
}

/** 解析 stream-json 一行 → DriverEvent[] */
export function parseLine(line: string, role: string | undefined): DriverEvent[] {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return []
  }
  const t = obj['type']
  if (t === 'system' && obj['subtype'] === 'init') {
    return [
      {
        type: 'init',
        sessionId: String(obj['session_id'] ?? ''),
        agents: (obj['agents'] as string[]) ?? [],
        tools: (obj['tools'] as string[]) ?? [],
      },
    ]
  }
  if (t === 'assistant') {
    const msg = obj['message'] as { content?: unknown[] } | undefined
    const out: DriverEvent[] = []
    for (const b of (msg?.content as Record<string, unknown>[]) ?? []) {
      if (b['type'] === 'text') out.push({ type: 'text', text: String(b['text'] ?? ''), role })
      else if (b['type'] === 'tool_use')
        out.push({ type: 'tool_use', tool: String(b['name'] ?? ''), input: b['input'], role })
    }
    return out
  }
  if (t === 'user') {
    const msg = obj['message'] as { content?: unknown[] } | undefined
    const out: DriverEvent[] = []
    for (const b of (msg?.content as Record<string, unknown>[]) ?? []) {
      if (b['type'] === 'tool_result') out.push({ type: 'tool_result', result: b['content'], role })
    }
    return out
  }
  if (t === 'result') {
    const usage = obj['usage'] as { output_tokens?: number } | undefined
    return [
      {
        type: 'done',
        cost: Number(obj['total_cost_usd'] ?? 0),
        usage: usage?.output_tokens ?? 0,
        reason: obj['subtype'] === 'success' ? 'success' : obj['is_error'] ? 'error' : 'cancelled',
      },
    ]
  }
  return []
}

/** spawn claude 子进程,解析 stream-json 推 events */
function runClaude(
  session: Session,
  prompt: string,
  opts: { allowedTools?: string[]; role?: string },
): void {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose']
  // spawnRole 禁所有工具(--tools '');send 放指定工具(--allowedTools)
  if (opts.allowedTools && opts.allowedTools.length) {
    args.push('--allowedTools', opts.allowedTools.join(','))
  } else {
    args.push('--tools', '')
  }
  const role = opts.role
  // 同 session 快速二次 spawn 时,先 kill 上一个未结束的子进程,防泄漏 + 事件交错(P1)
  const prev = sessionChild.get(session.id)
  if (prev && !prev.killed) prev.kill('SIGTERM')
  const child = spawn('claude', args, { cwd: session.cwd, env: process.env })
  sessionChild.set(session.id, child)
  // 超时保护(5min,claude 挂起时 kill 防 session 永久等待)
  const timer = setTimeout(() => {
    if (!child.killed) {
      child.kill('SIGTERM')
      push(session.id, { type: 'error', kind: 'spawn', message: 'claude 子进程超时(5min)被终止', recoverable: true })
    }
  }, 5 * 60 * 1000)

  let buf = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      for (const ev of parseLine(line, role)) push(session.id, ev)
    }
  })
  child.on('error', (e) => {
    clearTimeout(timer)
    push(session.id, { type: 'error', kind: 'spawn', message: e.message, recoverable: false })
  })
  child.on('close', () => {
    clearTimeout(timer)
    sessionChild.delete(session.id)
    const ch = channel(session.id)
    // 异常退出(无 result/无前置 error)时未推终止事件 → 补推 done,
    // 否则持久 SSE 消费方收不到本次 spawn 的终止信号,UI 卡在等待(P0)
    if (!ch.terminated) {
      ch.terminated = true
      ch.events.push({ type: 'done', cost: 0, usage: 0, reason: 'error' })
    }
    for (const w of ch.waiters) w()
    ch.waiters = []
  })
}

export const ccDriver: StudioDriver = {
  async startSession(cwd: string, _opts?: SessionOptions): Promise<Session> {
    const id = `cc-${Date.now()}-${++sessionSeq}`
    const session: Session = { id, cwd, closed: false }
    channel(id)
    sessions.set(id, session)
    return session
  },

  spawnRole(session: Session, role: string, prompt: string): void {
    const sys = readRolePrompt(session.cwd, role)
    const full = sys ? `${sys}\n\n---\n\n${prompt}` : prompt
    runClaude(session, full, { role })
  },

  send(session: Session, prompt: string): void {
    // 软触发主 agent 调 Agent/Task 工具(--resume 续主 session 留后续)
    runClaude(session, prompt, { allowedTools: ['Agent', 'Task', 'Read'], role: 'main' })
  },

  async *stream(session: Session): AsyncIterable<DriverEvent> {
    const ch = channel(session.id)
    while (!session.closed) {
      while (ch.events.length) {
        yield ch.events.shift() as DriverEvent
      }
      if (session.closed) return
      await new Promise<void>((resolve) => ch.waiters.push(resolve))
    }
  },

  respondApproval(_session: Session, _approval: ApprovalResponse): void {
    // headless -p 无交互审批(B 编排单步生成用不到)
  },

  async resume(sessionId: string): Promise<Session> {
    const session = sessions.get(sessionId)
    if (!session || session.closed || !channels.has(sessionId)) {
      throw new Error(`无法恢复未知或已关闭的 CC session:${sessionId}`)
    }
    return session
  },

  dispose(session: Session): void {
    session.closed = true
    // kill 子进程(防僵尸:claude 挂起时 dispose 不杀会泄漏)
    const child = sessionChild.get(session.id)
    if (child && !child.killed) child.kill('SIGTERM')
    sessionChild.delete(session.id)
    const ch = channels.get(session.id)
    if (ch) {
      for (const w of ch.waiters) w()
      ch.waiters = []
    }
    channels.delete(session.id)
    sessions.delete(session.id)
  },

  interrupt(session: Session): void {
    // kill 当前子进程 + 推 interrupted;标 terminated 防 close 再补 done。session 保留可再 spawn
    const child = sessionChild.get(session.id)
    if (child && !child.killed) child.kill('SIGTERM')
    const ch = channel(session.id)
    ch.terminated = true
    push(session.id, { type: 'interrupted', reason: 'user_cancel' })
  },

  emit(session: Session, ev: DriverEvent): void {
    // 编排层回推自定义事件(如 review 逐角进度)到 session 事件流,经主 SSE 转发前端
    push(session.id, ev)
  },

  isRunning(session: Session): boolean {
    // 生成中 = 子进程存活(未 kill 且未退出);SSE 新连接据此补发运行态快照
    const child = sessionChild.get(session.id)
    return !!child && !child.killed && child.exitCode === null
  },
}
