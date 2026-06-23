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
}
const channels = new Map<string, Channel>()

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
  const child = spawn('claude', args, { cwd: session.cwd, env: process.env })

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
    push(session.id, { type: 'error', kind: 'spawn', message: e.message, recoverable: false })
  })
  child.on('close', () => {
    // result 已推 done;若异常退出无 result,唤醒 waiter 避免 stream 卡死
    const ch = channel(session.id)
    for (const w of ch.waiters) w()
    ch.waiters = []
  })
}

export const ccDriver: StudioDriver = {
  async startSession(cwd: string, _opts?: SessionOptions): Promise<Session> {
    const id = `cc-${Date.now()}`
    const session: Session = { id, cwd, closed: false }
    channel(id)
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
    return { id: sessionId, cwd: '', closed: false }
  },

  dispose(session: Session): void {
    session.closed = true
    const ch = channels.get(session.id)
    if (ch) {
      for (const w of ch.waiters) w()
      ch.waiters = []
    }
    channels.delete(session.id)
  },
}
