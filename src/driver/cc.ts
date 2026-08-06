/**
 * CC driver（重构版）：provider 直连，不再 spawn claude CLI。
 *
 * driver 只做 SSE 基础设施：会话管理 + 事件总线（stream / emit / interrupt）。
 * AI 生成不再经 driver——/spawn 手动写稿 + outline + onboard 走 gen.ts generateText，
 * 结构化产出（submit_chapter 等）走 gen.ts generateTool（self-heal / rewrite / review / analysis），
 * 各自把 text / 进度经 driver.emit 回流 /stream。
 *
 * 事件总线为广播式：每 stream 消费者独立队列，emit 复制推给所有活跃消费者；
 * 无消费者时事件暂存 pre，首个新消费者接管（兼容「emit 在 stream 前」时序）。
 * 多 SSE 连接（前端 + 调试）各自完整消费，事件不被单消费者 shift 分散（Bug A 修复）。
 */
import type {
  Session,
  SessionOptions,
  DriverEvent,
  StudioDriver,
} from './types.js'

/** 单个 stream 消费者：独立队列 + 挂起等待句柄 */
interface Consumer {
  queue: DriverEvent[]
  notify: (() => void) | null
}
/** 每 session 一个事件总线（广播到所有消费者） */
interface Channel {
  consumers: Set<Consumer>
  /** 无消费者期间 emit 的暂存事件；首个新消费者接管 */
  pre: DriverEvent[]
  /** pre 是否已被某个消费者接管（防多消费者重放历史） */
  preTaken: boolean
}
const channels = new Map<string, Channel>()
/** session → AbortController（interrupt 时 abort，替代 kill 子进程）。cc 无生成时为懒占位，dispose/interrupt 兜底用 */
const sessionCtrl = new Map<string, AbortController>()
let sessionSeq = 0

function channel(id: string): Channel {
  let ch = channels.get(id)
  if (!ch) {
    ch = { consumers: new Set(), pre: [], preTaken: false }
    channels.set(id, ch)
  }
  return ch
}

function push(id: string, ev: DriverEvent): void {
  const ch = channel(id)
  if (ch.consumers.size === 0) {
    // 无消费者：仅 session 建立后首个消费者可接管前暂存；已被接管过则丢弃
    // （SSE 有 sync 快照兜底，重连不重放历史）
    if (!ch.preTaken) ch.pre.push(ev)
    return
  }
  // 广播：复制事件到每个活跃消费者队列，唤醒其挂起等待
  for (const c of ch.consumers) {
    c.queue.push(ev)
    if (c.notify) {
      const n = c.notify
      c.notify = null
      n()
    }
  }
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
    const consumer: Consumer = { queue: [], notify: null }
    ch.consumers.add(consumer)
    // 首个消费者接管无消费者期间暂存的事件（emit 在 stream 前的时序）
    if (!ch.preTaken && ch.pre.length > 0) {
      consumer.queue.push(...ch.pre)
      ch.pre.length = 0
      ch.preTaken = true
    }
    try {
      while (!session.closed) {
        while (consumer.queue.length) {
          yield consumer.queue.shift() as DriverEvent
        }
        if (session.closed) return
        await new Promise<void>((resolve) => {
          consumer.notify = resolve
        })
      }
    } finally {
      // 消费者断开（iter.return / 异常）即从广播组移除，不影响其他消费者
      ch.consumers.delete(consumer)
    }
  },

  dispose(session: Session): void {
    session.closed = true
    const ctrl = sessionCtrl.get(session.id)
    if (ctrl) ctrl.abort()
    sessionCtrl.delete(session.id)
    // 唤醒所有消费等待，令其检查 session.closed 退出
    const ch = channels.get(session.id)
    if (ch) {
      for (const c of ch.consumers) {
        if (c.notify) {
          const n = c.notify
          c.notify = null
          n()
        }
      }
      channels.delete(session.id)
    }
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
    // 同一 ctrl 重复登记（chat/self-heal 多轮循环每轮都注册同一个）→ 幂等跳过，不自 abort
    const old = sessionCtrl.get(session.id)
    if (old === ctrl) return
    // P2-6：换新 ctrl 时先 abort 旧的（防并发时前者变不可中断僵尸）
    if (old && !old.signal.aborted) old.abort()
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