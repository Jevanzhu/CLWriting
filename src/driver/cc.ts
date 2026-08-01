/**
 * CC driver（重构版）：provider 直连，不再 spawn claude CLI。
 *
 * spawnRole → 按 role 映射 system prompt → provider.stream() → 事件推 channel。
 * SSE /stream 读 channel（不变）；interrupt → AbortController.abort()（替代 kill 子进程）。
 *
 * 此路径为纯文本生成（无 tool_use）——供 /spawn 手动写稿 + outline + onboard。
 * 结构化产出（submit_chapter 等）走 gen.ts（self-heal / rewrite / review / analysis）。
 */
import { createProvider, currentProvider, type ProviderConf, type GenRequest } from '../ai/provider/index.js'
import type {
  Session,
  SessionOptions,
  ApprovalResponse,
  DriverEvent,
  StudioDriver,
} from './types.js'
import { WRITER_SYSTEM_LONG, ANALYST_SYSTEM, REVIEW_SYSTEMS } from '../ai/prompts/index.js'

/** 每 session 一个事件总线 */
interface Channel {
  events: DriverEvent[]
  waiters: Array<() => void>
  terminated?: boolean
}
const channels = new Map<string, Channel>()
const sessions = new Map<string, Session>()
/** session → AbortController（interrupt 时 abort，替代 kill 子进程） */
const sessionCtrl = new Map<string, AbortController>()
let sessionSeq = 0

/** 应用数据目录（initDriver 注入，provider 从此读 providers.json） */
let userDataPath: string | null = null

/** 初始化 driver（server 启动时调一次） */
export function initCcDriver(path: string | null): void {
  userDataPath = path
}

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

/** role → system prompt 映射（纯写作规则，不含工具指令） */
function roleToSystemPrompt(role: string): string {
  // review 角色：lens-review → REVIEW_SYSTEMS[lens]
  if (role.endsWith('-review')) {
    const lens = role === 'emotion-review' ? 'emotion_peak' : role.replace('-review', '')
    return REVIEW_SYSTEMS[lens] ?? ''
  }
  if (role === 'writer') return WRITER_SYSTEM_LONG
  if (role === 'analyst') return ANALYST_SYSTEM
  // outline / onboard / main 等：system prompt 在 user message 里，这里返空
  return ''
}

/** 读当前 provider conf；未配置 → null */
function getProviderConf(): ProviderConf | null {
  if (!userDataPath) return null
  return currentProvider(userDataPath)
}

/** 跑一次 provider 生成，推事件到 channel */
async function runProvider(
  session: Session,
  systemPrompt: string,
  prompt: string,
): Promise<void> {
  const conf = getProviderConf()
  if (!conf) {
    push(session.id, {
      type: 'error',
      kind: 'config',
      message: '未配置 AI 服务供应商。请在设置 → AI 中添加并启用。',
      recoverable: false,
    })
    push(session.id, { type: 'done', cost: 0, usage: 0, reason: 'error' })
    return
  }

  const ctrl = new AbortController()
  sessionCtrl.set(session.id, ctrl)

  // 超时保护（5min）
  const timer = setTimeout(() => ctrl.abort(), 5 * 60 * 1000)

  const req: GenRequest = {
    systemPrompt,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 8000,
  }

  try {
    const provider = createProvider(conf)
    for await (const ev of provider.stream(req, ctrl.signal)) {
      if (session.closed) break
      switch (ev.type) {
        case 'text':
          push(session.id, { type: 'text', text: ev.delta })
          break
        case 'done':
          push(session.id, {
            type: 'usage',
            cost: 0,
            tokens: ev.usage.outputTokens,
          })
          push(session.id, {
            type: 'done',
            cost: 0,
            usage: ev.usage.outputTokens,
            reason: 'success',
          })
          break
        case 'error':
          push(session.id, {
            type: 'error',
            kind: 'provider',
            message: ev.message,
            recoverable: ev.retryable,
          })
          break
        default:
          break
      }
    }
  } catch (e) {
    if (session.closed || ctrl.signal.aborted) {
      // 中断或 dispose：不报错
    } else {
      push(session.id, {
        type: 'error',
        kind: 'provider',
        message: e instanceof Error ? e.message : String(e),
        recoverable: false,
      })
    }
  } finally {
    clearTimeout(timer)
    sessionCtrl.delete(session.id)
    // 兜底：异常退出未推 done → 补推
    const ch = channel(session.id)
    if (!ch.terminated) {
      ch.terminated = true
      ch.events.push({ type: 'done', cost: 0, usage: 0, reason: 'success' })
    }
    for (const w of ch.waiters) w()
    ch.waiters = []
  }
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
    const sys = roleToSystemPrompt(role)
    void runProvider(session, sys, prompt)
  },

  send(session: Session, prompt: string): void {
    // send = 无 system prompt 的纯 user message（outline / onboard 等多源合成）
    void runProvider(session, '', prompt)
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
    // 无交互审批
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
    // abort 当前生成（替代 kill 子进程）
    const ctrl = sessionCtrl.get(session.id)
    if (ctrl) ctrl.abort()
    sessionCtrl.delete(session.id)
    const ch = channels.get(session.id)
    if (ch) {
      for (const w of ch.waiters) w()
      ch.waiters = []
    }
    channels.delete(session.id)
    sessions.delete(session.id)
  },

  interrupt(session: Session): void {
    // abort 当前生成 + 推 interrupted；session 保留可再 spawn
    const ctrl = sessionCtrl.get(session.id)
    if (ctrl) ctrl.abort()
    const ch = channel(session.id)
    ch.terminated = true
    push(session.id, { type: 'interrupted', reason: 'user_cancel' })
  },

  emit(session: Session, ev: DriverEvent): void {
    push(session.id, ev)
  },

  isRunning(session: Session): boolean {
    // 生成中 = 有未完成的 AbortController
    const ctrl = sessionCtrl.get(session.id)
    return !!ctrl && !session.closed
  },
}
