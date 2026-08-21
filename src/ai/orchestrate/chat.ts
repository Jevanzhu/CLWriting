/**
 * 对话助手 agent 编排器（方案 §3.4）——hh §八-16 拆分后只留装配与编排。
 *
 * 与 self-heal 平级的新编排——不是一套新管线。
 * agent 循环：AI 自主决策调工具（≤5 轮 / ≤30min），写操作需作者确认。
 *
 * 相位布局（纯搬家，行为不变）：
 * - 装配/并发锁/队列/入口 → 本件；运行态与 per-book 历史映射 → `chat/state.ts`
 * - 相位 b+c（历史恢复与谱系 / 会话与上下文）→ `chat/restore.ts`
 * - 相位 d（agent 轮循环 / 工具执行 / 确认闸）→ `chat/turns.ts`
 * - 相位 e（六失败出口收敛 finishTurn / 收尾压缩 finalizeHistory）→ `chat/finish.ts`
 *
 * 架构要点（照搬 self-heal 的并发锁 + 中断模式）：
 * - per-book `Map<ChatRunState>` 并发锁
 * - 编排级 `AbortController` 贯穿循环 + 总时长 deadline
 * - 工具确认用 `pending Map<callId, resolve>` + 超时兜底
 * - 失败回滚 `history.length = baseLen`（不是 pop()）
 * - `runTask` 传 `task:'chat'` + `bookRoot` → trace/记账自动覆盖
 * - 持 CHAT_SPEC 元数据直调 runTask（不走 runSpec，messages 是累积数组）
 */
import type { Session, StudioDriver } from '../../driver/types.js'
import { openSessionStore } from '../../events/store.js'
import type { SessionRecorder } from '../../events/chat-bridge.js'
import { emit, type ChatRunState } from './chat/state.js'
import { prepareChatRun } from './chat/restore.js'
import { runAgentTurns } from './chat/turns.js'

// hh §八-16：子件符号经本件再导出——外部（server API / 测试）import 路径全部不变
export { getHistory, clearChatHistory } from './chat/state.js'
export { waitConfirm } from './chat/turns.js'

// ── 常量 ──────────────────────────────────────────

const AGENT_DEADLINE_MS = 30 * 60_000
const CONFIRM_TIMEOUT_MS = 2 * 60_000

// ── 类型 ──────────────────────────────────────────

export interface ChatOpts {
  driver: StudioDriver
  mainSession: Session
  userDataPath: string
  bookRoot: string
  bookName: string
  /** 作者发送的消息（regenerate 时不填——复用已有 user 消息） */
  message?: string
  /** 作者选定讨论的章号（可选） */
  chapter?: number
  /** F1-P4：重新生成——parentSeq = 触发 user 的全局 seq，branchId = 变体组 */
  regenerate?: { parentSeq: number; branchId: string }
  /** 确认闸超时注入（单测用短超时） */
  confirmTimeoutMs?: number
  /** agent 总时长注入（单测用短 deadline，CC-P2-2） */
  deadlineMs?: number
}

// ── 并发锁 + 中断 + 确认 ──────────────────────────

const running = new Map<string, ChatRunState>()

/** #7：在途 runChat 的收尾 Promise（改名/删书/退出等待用；finally 清理完才 resolve） */
const settling = new Map<string, Promise<unknown>>()

/** 本书是否正在对话 */
export function isChatRunning(bookName: string): boolean {
  return running.has(bookName)
}

/** #7：等本书在途对话收尾（无在途立即返回）。abort 只是异步信号——straggler 编排要
 * 跑到下一个 await 点才解旋，期间的收尾写库在改名/删书的同步段之后恢复就会对已关库/
 * 已搬走路径写（对话以 error 收尾）。改名/删书/优雅退出在 abort 后等这里。
 * M-3：循环等到表项真正清空——drainNextChat 续链会在旧 promise resolve 前同步
 * 替换表项，只等一轮的旧实现拿到旧 promise 的 resolve 即返回，续链新 run 仍在途，
 * 等待方随后的删库/改名就与新 run 的收尾写库竞争（续链链长 ≤ 队列上限 10，循环有界）。 */
export async function waitChatSettled(bookName: string): Promise<void> {
  for (;;) {
    const p = settling.get(bookName)
    if (!p) return
    await p.catch(() => undefined)
  }
}

/** E1a（steer / B5 Inbox 合流）：per-book 待处理消息队列。
 * 对话运行中发来的消息入队（steer「入队让出」语义），当前轮正常完成后自动消费队头续链；
 * abort/error/超时则丢弃队列（cherry steer 四分支：aborted/error → 丢弃，持久化 user 行留历史可重发）。 */
interface PendingChatMsg {
  /** RB-AI-P2-1：逐条语义字段各自独立——排队时完整保留 message/regenerate/chapter，
   *  续链时不得从上一轮继承（base 含 regenerate 时续链曾走恢复分支吞掉排队新消息） */
  message?: string
  chapter?: number
  regenerate?: { parentSeq: number; branchId: string }
}
const pendingChats = new Map<string, PendingChatMsg[]>()
/** P3-4：每书待处理队列容量上限——失控客户端/脚本循环发消息不能无限撑内存；超出丢最旧 */
const MAX_PENDING_CHATS = 10

/** 中断本书的对话——abort + 放行挂起的确认 + 丢弃待处理队列（用户停止 = 后续指令一并作废） */
export function abortChat(bookName: string): boolean {
  const st = running.get(bookName)
  if (!st) return false
  for (const [, resolve] of st.pending) resolve(false)
  pendingChats.delete(bookName)
  st.ctrl.abort()
  return true
}

/** E1a：对话消息统一入口——无运行直接启动；运行中入队（当前轮结束自动续链）。
 * 返回 'started'（直接开跑）| 'queued'（已入队）。错误兜底 emit driver error（与 stream.ts 原 emitSpawnError 对齐）。 */
export function sendChatMessage(opts: ChatOpts): 'started' | 'queued' {
  if (running.has(opts.bookName)) {
    const q = pendingChats.get(opts.bookName) ?? []
    // P3-4：超容丢最旧（队列是「让出」语义，作者最新指令优先级高于陈旧排队消息）
    // AA-P3-1：丢弃必须可感知——API 已回 queued，若静默丢最旧，作者会以为所有消息都在排队
    if (q.length >= MAX_PENDING_CHATS) {
      const dropped = q.shift()!
      // RB-AI-P2-1：regenerate 项无 message，预览降级显示「(重新生成)」而非误报空消息
      const preview = (dropped.message || (dropped.regenerate ? '(重新生成)' : '(空消息)')).slice(0, 40)
      emit(opts, {
        type: 'notice',
        message: `对话队列已满：已丢弃最旧的排队消息「${preview}…」——你刚发送的这条会顶替它。`,
      })
    }
    // RB-AI-P2-1：排队项完整保留语义字段（此前只存 message/chapter——运行中发起的
    // regenerate 被降级为空 message 入队）
    q.push({ message: opts.message, chapter: opts.chapter, regenerate: opts.regenerate })
    pendingChats.set(opts.bookName, q)
    return 'queued'
  }
  void runChat(opts).catch((e) => {
    opts.driver.emit?.(opts.mainSession, {
      type: 'error',
      kind: 'chat',
      message: e instanceof Error ? e.message : String(e),
      recoverable: false,
    })
  })
  return 'started'
}

/** E1a：runChat 收尾续链——正常完成消费队头自动跑下一条；abort/error/超时丢弃队列。 */
function drainNextChat(base: ChatOpts, completedOk: boolean): void {
  const q = pendingChats.get(base.bookName)
  if (!q || q.length === 0) {
    pendingChats.delete(base.bookName)
    return
  }
  if (!completedOk) {
    pendingChats.delete(base.bookName)
    return
  }
  const next = q.shift()!
  if (q.length === 0) pendingChats.delete(base.bookName)
  // RB-AI-P2-1：环境字段（driver/session/userData/book 等来自 base）与逐条字段
  // （message/regenerate/chapter 来自队列项）分开组装——此前 {...base, message} 续链：
  // base 含 regenerate 时排队新消息走「恢复旧历史」分支被静默吞掉；next.chapter 缺省时
  // 误继承上一条的选定章。逐条字段一律以队列项为准（undefined 也覆盖，不继承）
  void runChat({
    ...base,
    message: next.message,
    chapter: next.chapter,
    regenerate: next.regenerate,
  }).catch((e) => {
    base.driver.emit?.(base.mainSession, {
      type: 'error',
      kind: 'chat',
      message: e instanceof Error ? e.message : String(e),
      recoverable: false,
    })
  })
}

/** 作者点了确认/取消（由 POST /chat/confirm 调用） */
export function resolveChatConfirm(bookName: string, callId: string, ok: boolean): boolean {
  const st = running.get(bookName)
  const resolve = st?.pending.get(callId)
  if (!resolve) return false
  st!.pending.delete(callId)
  resolve(ok)
  return true
}

// ── 主入口（编排） ────────────────────────────────

export function runChat(opts: ChatOpts): Promise<void> {
  // #7：收尾 Promise 登记——外层包装不改内部语义；then 双臂清理防派生 promise 悬挂
  const p = runChatInner(opts)
  settling.set(opts.bookName, p)
  const cleanup = (): void => {
    if (settling.get(opts.bookName) === p) settling.delete(opts.bookName)
  }
  p.then(cleanup, cleanup)
  return p
}

async function runChatInner(opts: ChatOpts): Promise<void> {
  const deadlineMs = opts.deadlineMs ?? AGENT_DEADLINE_MS
  const state: ChatRunState = {
    ctrl: new AbortController(),
    deadline: Date.now() + deadlineMs,
    pending: new Map(),
  }
  // CC-P2-2：deadline 定时器强制生效——此前 deadline 只在轮首检查，write_chapter 触发的
  // 嵌套 self-heal（单章多次重写 × 自身超时）或挂起中的确认闸期间完全不生效，整场
  // 对话可远超 30min。到点即 abort 编排级 ctrl：waitConfirm 监听 signal 放行取消、
  // 嵌套 self-heal 经 executeChatTool 的 abort 桥接同步中断；轮首检查保留兜底。
  const deadlineTimer = setTimeout(() => {
    state.timedOut = true
    state.ctrl.abort()
  }, deadlineMs)
  running.set(opts.bookName, state)
  // E1a：正常完成（emit chat_done）才续链；abort/error/超时丢弃队列
  let completedOk = false
  const confirmTimeout = opts.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS
  // F1-P1：事件库（userData 为空 → null，退化内存模式）；连接为进程内单例（引用计数），
  // finally 的 close() 是「释放引用」——归零才真关库
  // H-1（第六轮）：库打开必须包在降级 try/catch 里——磁盘满/目录只读/库文件损坏时
  // DatabaseSync 与 PRAGMA 同步抛错，而此前裸调位于 running.set 之后、主 try 之前，
  // finally 不执行：running 永不释放、deadline 定时器不清、drainNextChat 永不消费
  //（该书对话死锁到进程重启）。降级 null 走内存模式（prepareChatRun 本就接受 null），
  // 与 runner.ts / self-heal.ts 的 mkChain 同款；chat 面向作者，降级时 emit 提示。
  let store: ReturnType<typeof openSessionStore> = null
  try {
    store = openSessionStore(opts.userDataPath, opts.bookRoot)
  } catch (e) {
    store = null
    emit(opts, {
      type: 'notice',
      message: `事件库打开失败，本次对话将不留审计记录（重启应用或检查磁盘后重试）：${
        e instanceof Error ? e.message : String(e)
      }`,
    })
  }
  // Y-P1-1：recorder 提前声明——异常路径 finally 兜底 dispose（注销活跃登记，防孤儿修复误伤）
  let recorder: SessionRecorder | undefined

  try {
    // 相位 b+c：历史恢复与谱系 / 会话与上下文（recorder 创建当口经 onRecorder 回填，
    // 保证 finally 兜底 dispose 覆盖 buildChatContext 等后续步骤的异常路径）
    const run = prepareChatRun(opts, store, (r) => {
      recorder = r
    })
    // 相位 d：agent 轮循环（内含六失败出口与轮数触顶收尾）；markCompleted 在 chat_done
    // 当口先行置位——收尾压缩若抛异常，续链口径与拆分前一致（队列照常消费）
    completedOk = await runAgentTurns({
      opts,
      state,
      confirmTimeout,
      history: run.history,
      baseLen: run.baseLen,
      recorder: run.recorder,
      sys: run.sys,
      turnBranch: run.turnBranch,
      digests: run.digests,
      seqs: run.seqs,
      markCompleted: () => {
        completedOk = true
      },
    })
  } finally {
    clearTimeout(deadlineTimer)
    running.delete(opts.bookName)
    // E1a：steer 续链——正常完成自动消费队头；abort/error/超时丢弃队列
    drainNextChat(opts, completedOk)
    // Y-P1-1：注销活跃会话登记（幂等；close 已调过则 no-op）——异常跳过 close 的路径兜底
    recorder?.dispose()
    // F1-P1：释放事件库引用（单例引用计数；steer 续链已拿到自己的引用，不受影响）
    store?.close()
    // X-P2-11：对话终态注销 ctrl——isRunning 归 false（此前 chat_done 后仍登记，SSE 快照假报「生成中」）
    opts.driver.unregisterCtrl?.(opts.mainSession, state.ctrl)
  }
}
