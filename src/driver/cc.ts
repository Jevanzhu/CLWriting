/**
 * CC driver（重构版）：provider 直连，不再 spawn claude CLI。
 *
 * driver 只做 SSE 基础设施：会话管理 + 事件总线（stream / emit / interrupt）。
 * AI 生成不再经 driver——/spawn 手动写稿 + outline + onboard 走 gen.ts generateText，
 * 结构化产出（submit_chapter 等）走 gen.ts generateTool（self-heal / rewrite / review / analysis），
 * 各自把 text / 进度经 driver.emit 回流 /stream。
 */
import type {
  Session,
  SessionOptions,
  DriverEvent,
  StudioDriver,
} from './types.js'

/** 每 session 一个事件总线 */
interface Channel {
  events: DriverEvent[]
  waiters: Array<() => void>
}
const channels = new Map<string, Channel>()
/** session → AbortController（interrupt 时 abort，替代 kill 子进程）。cc 无生成时为懒占位，dispose/interrupt 兜底用 */
const sessionCtrl = new Map<string, AbortController>()
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
  for (const w of ch.waiters) w()
  ch.waiters = []
}

export const ccDriver: StudioDriver = {
  async startSession(cwd: string, _opts?: SessionOptions): Promise<Session> {
    const id = `cc-${Date.now()}-${++sessionSeq}`
    const session: Session = { id, cwd, closed: false }
    channel(id)
    return session
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

  dispose(session: Session): void {
    session.closed = true
    const ctrl = sessionCtrl.get(session.id)
    if (ctrl) ctrl.abort()
    sessionCtrl.delete(session.id)
    const ch = channels.get(session.id)
    if (ch) {
      for (const w of ch.waiters) w()
      ch.waiters = []
    }
    channels.delete(session.id)
  },

  interrupt(session: Session): void {
    // 推 interrupted（前端据此清 running；cc 无 driver 层生成可中断）
    const ctrl = sessionCtrl.get(session.id)
    if (ctrl) ctrl.abort()
    // 中断即注销 ctrl：isRunning 立即归 false（与 dispose 同口径，防 SSE 快照假报「生成中」）
    sessionCtrl.delete(session.id)
    channel(session.id)
    push(session.id, { type: 'interrupted', reason: 'user_cancel' })
  },

  // P1-2：编排层生成任务的 ctrl 登记——interrupt/isRunning 据此对真实请求生效
  registerCtrl(session: Session, ctrl: AbortController): void {
    sessionCtrl.set(session.id, ctrl)
  },

  emit(session: Session, ev: DriverEvent): void {
    push(session.id, ev)
  },

  isRunning(session: Session): boolean {
    const ctrl = sessionCtrl.get(session.id)
    return !!ctrl && !session.closed
  },
}