/**
 * mock driver：不调大模型的假事件流，供前端开发 / e2e 测试。
 *
 * 架构红线：mock 不调任何大模型（纯定时器模拟流式产出）。
 * 只做 SSE 基础设施：会话 + 事件总线（stream / emit / dispose）。
 * AI 生成不再经 driver——mock 链路由各端点自带 mock 快路径（tryMockTool / 文本模拟流）。
 *
 * 事件总线为广播式：每 stream 消费者独立队列，emit 复制推给所有活跃消费者；
 * 无消费者时事件暂存 pre，首个新消费者接管（与 cc driver 同构，多 SSE 连接各自完整消费）。
 */
import type {
  Session,
  SessionOptions,
  DriverEvent,
  StudioDriver,
} from './types.js'

/** 每 session 一个事件总线（广播到所有消费者）。
 *  B-19（第六十轮补修，与 cc.ts 同构）：cancelled——SSE 断开侧经 cancelStream
 *  唤醒 park 中的生成器令其自行 return（iter.return 只能在 yield 边界生效） */
interface Consumer {
  queue: DriverEvent[]
  notify: (() => void) | null
  cancelled: boolean
}

/** B-19：stream() 返回的生成器对象 → 其 consumer（cancelStream 据此唤醒） */
const streamCancels = new WeakMap<AsyncIterable<DriverEvent>, Consumer>()

/** B-19：唤醒 consumer——置 cancelled 并 resolve 挂起等待（幂等） */
function cancelConsumer(consumer: Consumer): void {
  consumer.cancelled = true
  if (consumer.notify) {
    const n = consumer.notify
    consumer.notify = null
    n()
  }
}
interface Channel {
  consumers: Set<Consumer>
  /** 无消费者期间 emit 的暂存事件；首个新消费者接管 */
  pre: DriverEvent[]
  preTaken: boolean
}

const channels = new Map<string, Channel>()
const sessions = new Map<string, Session>()
let sessionSeq = 0

/** AA-P3-2 同构（cc.ts 同款）：无消费者期间 pre 暂存上限——首个消费者接入前
 *  长流不再无限增堆内存；超出只留最近 N 个（旧事件进 sync 快照兜底） */
const MAX_PRE_EVENTS = 200

function channel(id: string): Channel {
  let ch = channels.get(id)
  if (!ch) {
    ch = { consumers: new Set(), pre: [], preTaken: false }
    channels.set(id, ch)
  }
  return ch
}

function push(id: string, ev: DriverEvent): void {
  // 低级项（第六轮）：dispose 后的迟到 emit 不复活已删除的 channel（微量资源残留）
  const ch = channels.get(id)
  if (!ch) return
  if (ch.consumers.size === 0) {
    // 无消费者：仅 session 建立后首个消费者可接管前暂存；已被接管过则丢弃
    // （SSE 有 sync 快照兜底，重连不重放历史）
    if (!ch.preTaken) {
      ch.pre.push(ev)
      // AA-P3-2 同构：pre cap——超出只留最近 N 个（首个消费者只接管最近 N 个）
      if (ch.pre.length > MAX_PRE_EVENTS) ch.pre.shift()
    }
    return
  }
  for (const c of ch.consumers) {
    c.queue.push(ev)
    if (c.notify) {
      const n = c.notify
      c.notify = null
      n()
    }
  }
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

  // B-19：stream 改工厂形态（生成器主体不变）——创建时在 WeakMap 登记取消句柄
  stream(session: Session): AsyncGenerator<DriverEvent> {
    const consumer: Consumer = { queue: [], notify: null, cancelled: false }
    const gen = (async function* (): AsyncGenerator<DriverEvent> {
      // 低级项（第六轮）：已 dispose 的会话不再建 channel（防复活 Map 残留）
      if (session.closed) return
      const ch = channel(session.id)
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
          // B-19：断开唤醒后的检查点——不再续 park，自行 return（finally 摘除 consumer）
          if (consumer.cancelled) return
          await new Promise<void>((resolve) => {
            consumer.notify = resolve
          })
        }
      } finally {
        ch.consumers.delete(consumer)
      }
    })()
    streamCancels.set(gen, consumer)
    return gen
  },

  cancelStream(iter: AsyncIterable<DriverEvent>): void {
    const consumer = streamCancels.get(iter)
    if (consumer) cancelConsumer(consumer)
  },

  dispose(session: Session): void {
    session.closed = true
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
    // 低级项（第六轮）：sessions 注销移出 if(ch)——channel 缺席（理论路径）也不留登记
    sessions.delete(session.id)
  },

  emit(session: Session, ev: DriverEvent): void {
    push(session.id, ev)
  },

  registerCtrl(): void {
    // mock 无可中断生成（生成是各端点 mock 快路即时返回）；noop 保持接口完整
  },

  unregisterCtrl(): void {
    // 同 registerCtrl：mock 无登记，注销亦 noop
  },
}

/** 测试钩子：活跃 channel / session 条目数（验证 dispose 后迟到 emit 不复活 Map 残留） */
export function debugCounts(): { channels: number; sessions: number } {
  return { channels: channels.size, sessions: sessions.size }
}
