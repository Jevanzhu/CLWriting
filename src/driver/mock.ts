/**
 * mock driver：不调大模型的假事件流，供前端开发 / e2e 测试。
 *
 * 架构红线：mock 不调任何大模型（纯定时器模拟流式产出）。
 * 只做 SSE 基础设施：会话 + 事件总线（stream / emit / dispose）。
 * AI 生成不再经 driver——mock 链路由各端点自带 mock 快路径（tryMockTool / 文本模拟流）。
 *
 * 事件总线为广播式：每 stream 消费者独立队列，emit 复制推给所有活跃消费者；
 * 无消费者时事件暂存 pre，首个新消费者接管（与 cc driver 同构，多 SSE 连接各自完整消费）。
 *
 * R62-40：与 cc.ts 的行为分叉点（抽共享总线是大重构，另立项；此处只文档化）：
 * - cc 有 execRing（E1b 迟到回放）+ pre/execRing/消费者队列三处上限（MAX_EXEC_RING=200、
 *   MAX_PRE_EVENTS、MAX_CONSUMER_QUEUE=200，M-P2-1 内存核查引入）；mock 无 execRing、
 *   无队列上限——测试流事件量受控，积压风险忽略不计，刻意保持简单。
 * - startSession 会推一个 init 事件（agents/tools 清单，mock 端点测试用）；cc 不发 init。
 * - mock 的 cancelled 唤醒（B-19）与 cc 同构；emit 复制语义一致。
 */
import type {
  Session,
  SessionOptions,
  DriverEvent,
  StudioDriver,
} from './types.js'

/** 每 session 一个事件总线（广播到所有消费者）。
 *  B-19（第六十轮补修，与 cc.ts 同构）：cancelled——SSE 断开侧经 cancelStream
 *  唤醒 park 中的生成器令其自行 return（iter.return 只能在 yield 边界生效）。
 *  M-P2-1（内存核查 2026-08-25，与 cc.ts 同构）：dropNotified——本轮积压已补发过
 *  丢事件 notice，队列拉空时复位（每轮积压只告知一次） */
interface Consumer {
  queue: DriverEvent[]
  notify: (() => void) | null
  cancelled: boolean
  dropNotified: boolean
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
/** M-P2-1（内存核查 2026-08-25，与 cc.ts 同构）：已连接消费者队列上限——慢速/
 *  僵尸消费者在长流期间队列不再无限积压；超限丢最旧 + 补发 notice（丢弃可感知） */
export const MAX_CONSUMER_QUEUE = 200

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
    // 内存核查（2026-08-25 M-P2-1，与 cc.ts 同构）：消费者队列 cap——超限丢最旧
    // 腾位；每轮积压首次超限时补发 notice。R73-9（二十一轮 A-9）：notice 走「容量 +1
    // 内部槽」——修复前首次溢出连丢 2 条真实事件（先腾位再腾 notice 位）；现在每次
    // 溢出只丢 1 条最旧真实事件（瞬态上限 MAX_CONSUMER_QUEUE+1，与 cc.ts 同构）。
    if (c.queue.length >= MAX_CONSUMER_QUEUE) {
      c.queue.shift()
      if (!c.dropNotified) {
        c.dropNotified = true
        c.queue.push({
          type: 'notice',
          message: '事件队列已满：消费过慢或连接停滞，最旧的排队事件已被丢弃（运行中的执行可经重连回放最近事件补齐）',
        })
      }
    }
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
    const consumer: Consumer = { queue: [], notify: null, cancelled: false, dropNotified: false }
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
          // M-P2-1（内存核查 2026-08-25，与 cc.ts 同构）：队列拉空——复位丢事件告知
          // 标记，下一轮积压再超限时重新补发一次 notice
          consumer.dropNotified = false
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
