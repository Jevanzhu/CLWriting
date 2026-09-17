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
import { replayNeedsResetAnchor, REPLAY_RESET } from './replay-anchor.js'

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
/** E1b：生成执行的边界事件（业务语义：执行开始清空本腿 ring、执行终态停止本腿累积） */
const EXEC_START = new Set(['chat_start', 'self_heal_batch', 'role_spawn'])
const EXEC_END = new Set(['chat_done', 'chat_error', 'self_heal_result', 'done', 'interrupted'])
/** E1b：迟到回放 ring 容量（cap 协议单元——事件本身，非原始 delta）。
 *  execRing 分桶批（2026-09-17 单立清账）：chat 腿 / 写手腿各一桶，cap 按桶独立 */
export const MAX_EXEC_RING = 200
/** AA-P3-2：无消费者期间 pre 暂存上限（同 MAX_EXEC_RING 量级）——首个消费者接入前
 *  长自愈流不再无限增堆内存；超出只留最近 N 个（旧事件进 sync 快照/日志兜底） */
const MAX_PRE_EVENTS = MAX_EXEC_RING
/** M-P2-1（内存核查 2026-08-25）：已连接消费者队列上限（pre / execRing 同量级）——
 *  慢速/僵尸 SSE 消费者（连接未断但网络停滞、生成器不再被拉动）在长连写期间
 *  队列不再无限积压；超限丢最旧 + 补发 notice（AA-P3-1 口径：丢弃可感知） */
export const MAX_CONSUMER_QUEUE = 200
/** E1b：单腿迟到回放桶——本腿活跃执行期间累积最近 N 个协议单元 */
interface ExecBucket {
  ring: DriverEvent[]
  active: boolean
}
/** 每 session 一个事件总线（广播到所有消费者） */
interface Channel {
  consumers: Set<Consumer>
  /** 无消费者期间 emit 的暂存事件；首个新消费者接管 */
  pre: DriverEvent[]
  /** pre 是否已被某个消费者接管（防多消费者重放历史） */
  preTaken: boolean
  /** E1b：迟到回放 ring 按腿分桶（2026-09-17 单立清账批）——chat 腿（chat_* 族）与
   *  写手腿（role_spawn、self_heal_*、text、done 等生成族）各持独立累积 + active。
   *  此前单环 + 单布尔在「chat 内嵌 write_chapter」并发形态下丢段三途径：内嵌
   *  EXEC_START 清掉 chat 已积累段 / 内嵌 EXEC_END 提前熄灭 active 致外层 chat 零回放 /
   *  两腿共享 200 槽互挤（workbench 流式正文无持久化兜底，ring 回放是重连唯一恢复通道）。
   *  桶间拼接序安全：前端 useSse 按事件族分流（chat_* → chat store，其余 → workbench
   *  dispatch），两 store 各自只消费本族事件。 */
  chat: ExecBucket
  writer: ExecBucket
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
    ch = {
      consumers: new Set(),
      pre: [],
      preTaken: false,
      chat: { ring: [], active: false },
      writer: { ring: [], active: false },
    }
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

/** 事件按族归腿：chat_* 族 → chat 腿，其余（role_spawn、self_heal_*、text、done…）→ 写手腿。
 *  EXEC_START/END 按族各自只开/关本腿桶——chat_start/chat_done/chat_error 归 chat 腿、
 *  self_heal_batch/role_spawn/self_heal_result/done 归写手腿，内嵌写章不再殃及外层
 *  chat 腿的回放积累。 */
function execBucket(ch: Channel, type: string): ExecBucket {
  return type.startsWith('chat_') ? ch.chat : ch.writer
}

/** 尾追 + cap 裁剪（丢最旧）——本腿入环与 interrupted 全桶入环共用 */
function ringAppend(ring: DriverEvent[], ev: DriverEvent): void {
  ring.push(ev)
  if (ring.length > MAX_EXEC_RING) ring.shift()
}

function push(id: string, ev: DriverEvent): void {
  // 低级项（第六轮）：dispose 后的迟到 emit/interrupt 不复活已删除的 channel——
  // 原先 channel(id) 懒建会把 Map 条目重新造出来且无人再清（微量资源残留）
  const ch = channels.get(id)
  if (!ch) return
  // E1b：维护本腿活跃执行 ring——本腿执行开始清空重开，执行中累积最近 N 个协议单元
  // （execRing 分桶批 2026-09-17：跨腿 EXEC_START 不再清他腿积累）
  const b = execBucket(ch, ev.type)
  if (EXEC_START.has(ev.type)) {
    b.ring = []
    b.active = true
  }
  // AA-P3-3：终态事件先入 ring 再关 active——迟到连接回放能看到「执行已结束」锚
  // （chat_done/chat_error/self_heal_result…），此前 EXEC_END 先置 active=false，
  // 终态被挡在 ring 外，回放只剩过程不见结局
  if (b.active) ringAppend(b.ring, ev)
  if (EXEC_END.has(ev.type)) {
    if (ev.type === 'interrupted') {
      // 用户中断 = 全停语义：终态锚进入所有活跃腿（本腿已随上文入环）后关全部——
      // 与 abortAllCtrls「一个 session 全停」同口径
      if (ch.chat.active && b !== ch.chat) ringAppend(ch.chat.ring, ev)
      if (ch.writer.active && b !== ch.writer) ringAppend(ch.writer.ring, ev)
      ch.chat.active = false
      ch.writer.active = false
    } else {
      b.active = false
    }
  }
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
    // 一支（原先无上限），超限丢最旧腾位；每轮积压首次超限时补发 notice。
    // R73-9（二十一轮 A-9）：notice 走「容量 +1 内部槽」——修复前首次溢出先 shift 腾位、
    // 再 shift 一位给 notice，首轮实际连丢 2 条真实事件。现在每次溢出只丢 1 条最旧
    // 真实事件，notice 不占真实事件位（队列瞬态上限 MAX_CONSUMER_QUEUE+1，notice
    // 消费后回落 ≤ cap），文案「最旧的排队事件已被丢弃」与实际丢弃数一致。
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
      // R-P1-1（2026-09-08 全量代码重审 批1）：回放前导清屏锚——cap 溢出时回放头部的自然锚
      // （role_spawn/text_reset）被挤出，迟到消费者把重放 text 增量盲追加到断连前已积累的
      // textOut 上即整段重复（chapter 级生成每 delta 一协议单元，溢出是常态）；首个 text 增量
      // 前无锚时补发合成 text_reset，重放文本从空重建（语义见 replay-anchor.ts）。
      if (!ch.preTaken && ch.pre.length > 0) {
        if (replayNeedsResetAnchor(ch.pre)) consumer.queue.push(REPLAY_RESET)
        consumer.queue.push(...ch.pre)
        ch.pre.length = 0
        ch.preTaken = true
      } else {
        // execRing 分桶批（2026-09-17）：活跃腿拼接回放（chat 段在前、写手段在后）——
        // 桶间拼接序对两 store 各自视图保序安全（前端按族分流）；清屏锚对拼接序列
        // 整体判一次（chat_* 无 text 事件、锚语义只涉 workbench textOut，与分桶前
        // 单环单检等价）
        const replay = [
          ...(ch.chat.active ? ch.chat.ring : []),
          ...(ch.writer.active ? ch.writer.ring : []),
        ]
        if (replay.length > 0) {
          if (replayNeedsResetAnchor(replay)) consumer.queue.push(REPLAY_RESET)
          consumer.queue.push(...replay)
        }
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
    // R27-92（二十七轮）：已 dispose 会话拒收登记——此前懒建 byOwner 会把 dispose 刚删的
    // sessionCtrls 条目复活且无人再清（Map 泄漏）；且复活后 interrupt/dispose 兜底已跑过，
    // 迟到登记的真实在途请求从此无人能 abort（控制权丢失）——故登记即 abort 该 ctrl，
    // 让请求立即终止而不是挂在孤儿条目里跑完。
    if (session.closed) {
      if (!ctrl.signal.aborted) ctrl.abort()
      return
    }
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
