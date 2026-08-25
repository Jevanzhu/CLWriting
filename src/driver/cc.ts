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

/** 单个 stream 消费者：独立队列 + 挂起等待句柄。
 *  B-19（第六十轮补修）：cancelled——SSE 断开侧经 cancelStream 唤醒 park 中的
 *  生成器令其自行 return（iter.return 只能在 yield 边界生效，此前断开后生成器
 *  悬挂在内部 await 直到该书下一 driver 事件才被推进回收）。
 *  M-P2-1（内存核查 2026-08-25）：dropNotified——本轮积压已补发过丢事件 notice，
 *  队列拉空时复位（每轮积压只告知一次，不逐条刷屏） */
interface Consumer {
  queue: DriverEvent[]
  notify: (() => void) | null
  cancelled: boolean
  dropNotified: boolean
}

/** B-19：stream() 返回的生成器对象 → 其 consumer（cancelStream 据此唤醒） */
const streamCancels = new WeakMap<AsyncIterable<DriverEvent>, Consumer>()

/** B-19：唤醒 consumer——置 cancelled 并 resolve 挂起等待（幂等；未 park 时仅置标记，
 *  生成器在下轮检查点自行 return） */
function cancelConsumer(consumer: Consumer): void {
  consumer.cancelled = true
  if (consumer.notify) {
    const n = consumer.notify
    consumer.notify = null
    n()
  }
}
/** E1b：生成执行的边界事件（业务语义：执行开始清空 ring、执行终态停止累积） */
const EXEC_START = new Set(['chat_start', 'self_heal_batch', 'role_spawn'])
const EXEC_END = new Set(['chat_done', 'chat_error', 'self_heal_result', 'done', 'interrupted'])
/** E1b：迟到回放 ring 容量（cap 协议单元——事件本身，非原始 delta） */
export const MAX_EXEC_RING = 200
/** AA-P3-2：无消费者期间 pre 暂存上限（同 MAX_EXEC_RING 量级）——首个消费者接入前
 *  长自愈流不再无限增堆内存；超出只留最近 N 个（旧事件进 sync 快照/日志兜底） */
const MAX_PRE_EVENTS = MAX_EXEC_RING
/** M-P2-1（内存核查 2026-08-25）：已连接消费者队列上限（pre / execRing 同量级）——
 *  慢速/僵尸 SSE 消费者（连接未断但网络停滞、生成器不再被拉动）在长连写期间
 *  队列不再无限积压；超限丢最旧 + 补发 notice（AA-P3-1 口径：丢弃可感知） */
export const MAX_CONSUMER_QUEUE = 200
/** 每 session 一个事件总线（广播到所有消费者） */
interface Channel {
  consumers: Set<Consumer>
  /** 无消费者期间 emit 的暂存事件；首个新消费者接管 */
  pre: DriverEvent[]
  /** pre 是否已被某个消费者接管（防多消费者重放历史） */
  preTaken: boolean
  /** E1b：活跃执行期间的事件 ring（迟到回放）——执行开始清空、执行中累积最近 N 个协议单元 */
  execRing: DriverEvent[]
  /** E1b：是否有活跃执行（执行边界事件维护） */
  execActive: boolean
}
const channels = new Map<string, Channel>()
/** session → owner 分槽的 AbortController（interrupt 时全部 abort，替代 kill 子进程）。
 *  M-1（第八轮）：单槽改分槽——chat 与 self-heal 按设计可并发（纯问答），原先单槽
 *  register 的 P2-6「换新先 abort 旧」会把在途 self-heal 的 ctrl 静默掐断；owner
 *  分槽后同编排换新保持抢占语义，跨编排互不 abort，interrupt/dispose 兜底全量终止。 */
interface CtrlSlot {
  ctrl: AbortController
  owner: string
}
const sessionCtrls = new Map<string, Map<string, CtrlSlot>>()
let sessionSeq = 0

function channel(id: string): Channel {
  let ch = channels.get(id)
  if (!ch) {
    ch = { consumers: new Set(), pre: [], preTaken: false, execRing: [], execActive: false }
    channels.set(id, ch)
  }
  return ch
}

/** M-1（第八轮）：终止 session 下全部在途 ctrl（interrupt/dispose 共用）——owner 分槽后
 *  一个 session 可能同时挂 chat 与 self-heal/spawn 两路，用户中断语义是全停 */
function abortAllCtrls(sessionId: string): void {
  const byOwner = sessionCtrls.get(sessionId)
  if (!byOwner) return
  for (const slot of byOwner.values()) {
    if (!slot.ctrl.signal.aborted) slot.ctrl.abort()
  }
}

function push(id: string, ev: DriverEvent): void {
  // 低级项（第六轮）：dispose 后的迟到 emit/interrupt 不复活已删除的 channel——
  // 原先 channel(id) 懒建会把 Map 条目重新造出来且无人再清（微量资源残留）
  const ch = channels.get(id)
  if (!ch) return
  // E1b：维护活跃执行 ring——执行开始清空重开，执行中累积最近 N 个协议单元
  if (EXEC_START.has(ev.type)) {
    ch.execRing = []
    ch.execActive = true
  }
  // AA-P3-3：终态事件先入 ring 再关 active——迟到连接回放能看到「执行已结束」锚
  // （chat_done/chat_error/self_heal_result…），此前 EXEC_END 先置 active=false，
  // 终态被挡在 ring 外，回放只剩过程不见结局
  if (ch.execActive) {
    ch.execRing.push(ev)
    if (ch.execRing.length > MAX_EXEC_RING) ch.execRing.shift()
  }
  if (EXEC_END.has(ev.type)) ch.execActive = false
  if (ch.consumers.size === 0) {
    // 无消费者：仅 session 建立后首个消费者可接管前暂存；已被接管过则丢弃
    // （SSE 有 sync 快照兜底，重连不重放历史）
    if (!ch.preTaken) {
      ch.pre.push(ev)
      // AA-P3-2：pre cap——超过只留最近 N 个（首个消费者只接管最近 N 个）
      if (ch.pre.length > MAX_PRE_EVENTS) ch.pre.shift()
    }
    return
  }
  // 广播：复制事件到每个活跃消费者队列，唤醒其挂起等待
  for (const c of ch.consumers) {
    // 内存核查（2026-08-25 M-P2-1）：消费者队列 cap——广播腿是 pre/execRing 之外的
    // 一支（原先无上限），超限丢最旧腾位；每轮积压首次超限时再腾一位补发 notice
    // （notice 自身也占队列位，入队后长度恒 ≤ MAX_CONSUMER_QUEUE）
    if (c.queue.length >= MAX_CONSUMER_QUEUE) {
      c.queue.shift()
      if (!c.dropNotified) {
        c.queue.shift()
        c.queue.push({
          type: 'notice',
          message: '事件队列已满：消费过慢或连接停滞，最旧的排队事件已被丢弃（运行中的执行可经重连回放最近事件补齐）',
        })
        c.dropNotified = true
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

export const ccDriver: StudioDriver = {
  async startSession(cwd: string, _opts?: SessionOptions): Promise<Session> {
    const id = `cc-${Date.now()}-${++sessionSeq}`
    const session: Session = { id, cwd, closed: false }
    channel(id)
    return session
  },

  // B-19：stream 改工厂形态（生成器主体不变）——创建时在 WeakMap 登记取消句柄，
  // cancelStream 据此唤醒 park 在内部 await 的生成器（接口签名不变，返回 AsyncGenerator
  // 仍是 AsyncIterable）
  stream(session: Session): AsyncGenerator<DriverEvent> {
    const consumer: Consumer = { queue: [], notify: null, cancelled: false, dropNotified: false }
    const gen = (async function* (): AsyncGenerator<DriverEvent> {
      // 低级项（第六轮）：已 dispose 的会话不再建 channel（原先懒建复活 Map 条目无人清）
      if (session.closed) return
      const ch = channel(session.id)
      ch.consumers.add(consumer)
      // E1b：迟到回放——pre（无消费者期间完整暂存）优先；已被接管过则回放活跃执行的 execRing
      // （cap 协议单元，新 listener 加入时顺序重放，看到当前执行已流式内容）
      if (!ch.preTaken && ch.pre.length > 0) {
        consumer.queue.push(...ch.pre)
        ch.pre.length = 0
        ch.preTaken = true
      } else if (ch.execActive && ch.execRing.length > 0) {
        consumer.queue.push(...ch.execRing)
      }
      try {
        while (!session.closed) {
          while (consumer.queue.length) {
            yield consumer.queue.shift() as DriverEvent
          }
          // M-P2-1（内存核查 2026-08-25）：队列拉空——复位丢事件告知标记，
          // 下一轮积压再超限时重新补发一次 notice
          consumer.dropNotified = false
          if (session.closed) return
          // B-19：断开唤醒后的检查点——不再续 park，自行 return（finally 摘除 consumer）
          if (consumer.cancelled) return
          await new Promise<void>((resolve) => {
            consumer.notify = resolve
          })
        }
      } finally {
        // 消费者断开（cancelStream 唤醒自行 return / iter.return / 异常）即从广播组移除，
        // 不影响其他消费者
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
    abortAllCtrls(session.id)
    sessionCtrls.delete(session.id)
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
    abortAllCtrls(session.id)
    // 中断即注销全部 ctrl：isRunning 立即归 false（与 dispose 同口径，防 SSE 快照假报「生成中」）
    sessionCtrls.delete(session.id)
    // 低级项（第六轮）：不再 channel(id) 懒建——push 已对已删 channel 短路，防复活
    push(session.id, { type: 'interrupted', reason: 'user_cancel' })
  },

  // P1-2：编排层生成任务的 ctrl 登记——interrupt/isRunning 据此对真实请求生效。
  // M-1（第八轮）：owner 分槽——同 owner 换新 ctrl 保持 P2-6「先 abort 旧」（chat/
  // self-heal 多轮循环每轮换新的既定语义）；跨 owner（chat 问答 × self-heal/spawn
  // 写稿的既定并存）不互相 abort——原先单槽覆盖会把在途十几分钟的批量写章 ctrl
  // 换成一句自然提问的 ctrl，旧请求被静默 abort（self-heal 报 aborted）。
  registerCtrl(session: Session, ctrl: AbortController, owner?: string): void {
    const own = owner ?? ''
    let byOwner = sessionCtrls.get(session.id)
    if (!byOwner) {
      byOwner = new Map()
      sessionCtrls.set(session.id, byOwner)
    }
    // 同一 ctrl 重复登记（chat/self-heal 多轮循环每轮都注册同一个）→ 幂等跳过，不自 abort
    const old = byOwner.get(own)
    if (old?.ctrl === ctrl) return
    // P2-6：同编排换新 ctrl 时先 abort 旧的（防并发时前者变不可中断僵尸）
    if (old && !old.ctrl.signal.aborted) old.ctrl.abort()
    byOwner.set(own, { ctrl, owner: own })
  },

  // X-P2-11：生成终态注销——isRunning 立即归 false（此前 done 后仍登记，SSE 快照假报「生成中」，
  // 前端误显不可生成）。只注销自己：晚到的 unregister 不得抹掉后来的新登记。
  unregisterCtrl(session: Session, ctrl: AbortController): void {
    const byOwner = sessionCtrls.get(session.id)
    if (!byOwner) return
    for (const [owner, slot] of byOwner) {
      if (slot.ctrl === ctrl) byOwner.delete(owner)
    }
    if (byOwner.size === 0) sessionCtrls.delete(session.id)
  },

  emit(session: Session, ev: DriverEvent): void {
    push(session.id, ev)
  },

  isRunning(session: Session): boolean {
    const byOwner = sessionCtrls.get(session.id)
    if (!byOwner) return false
    // X-P2-11：aborted 的 ctrl 不算在途（编排层直接 abort 自身 ctrl 而非走 interrupt 的路径兜底）
    for (const slot of byOwner.values()) {
      if (!slot.ctrl.signal.aborted) return !session.closed
    }
    return false
  },
}

/** 测试钩子：活跃 channel 条目数（验证 dispose 后迟到 emit/interrupt/stream 不复活 Map 残留） */
export function debugChannelCount(): number {
  return channels.size
}
