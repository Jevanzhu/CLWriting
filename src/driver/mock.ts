/**
 * mock driver：不调大模型的假事件流，供前端开发 / e2e 测试。
 *
 * 架构红线：mock 不调任何大模型（纯定时器模拟流式产出）。
 * 只做 SSE 基础设施：会话 + 事件总线（stream / emit / dispose）。
 * AI 生成不再经 driver——mock 链路由各端点自带 mock 快路径（tryMockTool / 文本模拟流）。
 */
import type {
  Session,
  SessionOptions,
  ApprovalResponse,
  DriverEvent,
  StudioDriver,
} from './types.js'

/** 每 session 一个事件总线(push 到队列,stream 排空 / 等) */
interface MockChannel {
  events: DriverEvent[]
  waiters: Array<() => void>
}

const channels = new Map<string, MockChannel>()
const sessions = new Map<string, Session>()
let sessionSeq = 0

function channel(id: string): MockChannel {
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

export const mockDriver: StudioDriver = {
  async startSession(cwd: string, _opts?: SessionOptions): Promise<Session> {
    const id = `mock-${Date.now()}-${++sessionSeq}`
    const session: Session = { id, cwd, closed: false }
    channel(id)
    sessions.set(id, session)
    push(id, {
      type: 'init',
      sessionId: id,
      agents: ['writer', 'continuity-review', 'editor-review', 'reader-review', 'analyst'],
      tools: ['Read', 'Edit', 'Write', 'Bash(clwriting:*)'],
    })
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

  respondApproval(_session: Session, _approval: ApprovalResponse): void {
    // mock 不产生 approval
  },

  async resume(sessionId: string): Promise<Session> {
    const session = sessions.get(sessionId)
    if (!session || session.closed || !channels.has(sessionId)) {
      throw new Error(`无法恢复未知或已关闭的 mock session:${sessionId}`)
    }
    return session
  },

  dispose(session: Session): void {
    session.closed = true
    const ch = channels.get(session.id)
    if (ch) {
      for (const w of ch.waiters) w()
      ch.waiters = []
    }
    channels.delete(session.id)
    sessions.delete(session.id)
  },

  emit(session: Session, ev: DriverEvent): void {
    push(session.id, ev)
  },
}