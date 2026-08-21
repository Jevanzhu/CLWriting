/**
 * chat 相位 b+c：历史恢复与谱系 + 会话与上下文（hh §八-16 自 chat.ts runChat 拆出，纯搬家）。
 *
 * - b：regenerate 分支重建（F1-P4）/ 默认分支投影（Z-P1-2）/ msgSeqs 批内换算
 *   `commitPendingMsgSeqs`（Y-P2-7）/ 活跃分支归属；
 * - c：createSession / buildChatContext / chatSystem / 三 digest（P3 血缘）/ user push 时序（#3b）。
 */
import type { ChatMsg } from '../../provider/types.js'
import type { SessionStore } from '../../../events/store.js'
import { selectBranch, selectBranchTo } from '../../../events/branch-tree.js'
import { SessionRecorder, sessionStartEvent, userMessageEvent, loadHistoryWithSeqs } from '../../../events/chat-bridge.js'
import { digest16 } from '../../../events/lineage.js'
import { buildChatContext, chatSystem } from '../../prompts/chat.js'
import type { ChatOpts } from '../chat.js'
import { getHistory, msgSeqMap, activeBranchByBook, emit } from './state.js'

/** Y-P2-7：批内序号 → 全局 seq 换算收口——pendingMsgSeqs 累积本回合各消息事件的批内
 *  序号，flush 拿到落库区间后一次换算并入 msgSeqs（三处重复换算，改口径极易漏改一处） */
export interface ChatSeqLedger {
  /** 每条历史消息对应的事件 seq（压缩遮蔽用） */
  msgSeqs: number[][]
  /** 本回合待换算的批内序号（number=单事件，number[]=合成一条消息的多个事件） */
  pendingMsgSeqs: Array<number | number[]>
  commitPendingMsgSeqs(range: { first: number; last: number } | null): void
}

export interface PreparedChatRun {
  history: ChatMsg[]
  sys: string
  recorder: SessionRecorder
  baseLen: number
  /** Z-P1-2：本回合分支元数据（regenerate=变体根 / 延续活跃分支 / 线性 undefined） */
  turnBranch: { parentSeq?: number; branchId?: string } | undefined
  /** P3 血缘：注入快照指纹（「模型可见 ⟺ 已记录」的登记依据） */
  digests: { settings: string; revision?: string; skills?: string }
  seqs: ChatSeqLedger
}

/**
 * 相位 b+c 一次走完。onRecorder 在 SessionRecorder 创建当口回调——runChat 的 finally
 * 依赖它兜底 dispose（Y-P1-1：buildChatContext 等后续步骤抛异常时防孤儿活跃登记）。
 */
export function prepareChatRun(
  opts: ChatOpts,
  store: SessionStore | null,
  onRecorder: (r: SessionRecorder) => void,
): PreparedChatRun {
  const history = getHistory(opts.bookName)
  // F1-P1：事件库（userData 为空 → null，退化内存模式）+ 跨重启恢复。
  // 内存无历史且库有投影 → 恢复（LRU 逐出/重启后都走这条）。
  let msgSeqs = msgSeqMap.get(opts.bookName) ?? []
  if (opts.regenerate && store) {
    // F1-P4：重新生成——总是从事件重建到触发 user（parentSeq）为止（不依赖内存历史，
    // 内存可能含旧分支或被截断的历史），沿分支路径
    const restored = loadHistoryWithSeqs(selectBranchTo(store.listEvents(opts.bookName), opts.regenerate.parentSeq))
    history.length = 0
    history.push(...restored.msgs)
    msgSeqs = restored.seqsPerMsg
    msgSeqMap.set(opts.bookName, msgSeqs)
  } else if (store && history.length === 0) {
    // Z-P1-2：恢复走默认分支投影（最新变体组 + 线性兜底），与 GET /chat/history 视图同口径——
    // 全量投影会把兄弟变体顺序堆进模型上下文（regenerate 过的书重启后答非所问）
    const restored = loadHistoryWithSeqs(selectBranch(store.listEvents(opts.bookName)))
    if (restored.msgs.length > 0) {
      history.push(...restored.msgs)
      msgSeqs = restored.seqsPerMsg
      msgSeqMap.set(opts.bookName, msgSeqs)
    }
  }
  // 防御：msgSeqs 与 history 长度错位（旧进程残留）→ 尾部补齐/截尾对齐，而非清空。
  // 清空会让后续 append 永久错位：finalizeHistory 的 trim 遮蔽 splice(0, cut) 拿到的
  // 是「保留消息」的 seq（误遮蔽 → 重放里活消息隐身），被裁消息反而无遮蔽（幽灵回归）。
  // 不足（尾部缺）：唯一自然成因是回合 commit 点 flush 抛错——history 已 push 而 seq
  // 未追加，缺口必在尾部。按尾部补 []（该消息 seq 未知，本就无法遮蔽），既有 seq 与
  // 各自消息的对齐原样保留。前缀 unshift 会把全部 seq 整体后移 k 位——从此 s_i 声称
  // 属于错误的消息，错位被固化而非修复。
  // 超长（尾部多）：来自回合回滚——finish 把 history 截回 baseLen 而已 commit 的 seq
  // 留在尾部（对应事件已被 closeMaskingAll 遮蔽，是死 seq），截尾即恢复活消息对齐。
  if (msgSeqs.length !== history.length) {
    if (msgSeqs.length < history.length) {
      while (msgSeqs.length < history.length) msgSeqs.push([])
    } else {
      msgSeqs.length = history.length
    }
    msgSeqMap.set(opts.bookName, msgSeqs)
  }
  // Z-P1-2（G1 写侧谱系）：本回合分支归属——regenerate = parentSeq + 新 branchId；
  // 普通回合延续本书活跃分支（只带 branchId 进组，不设 parentSeq——不是变体根）；
  // 无活跃分支（线性书/清空后）→ undefined，行为与旧版完全一致
  const activeBranch = activeBranchByBook.get(opts.bookName)
  const turnBranch: { parentSeq?: number; branchId?: string } | undefined = opts.regenerate
    ? { parentSeq: opts.regenerate.parentSeq, branchId: opts.regenerate.branchId }
    : activeBranch !== undefined
      ? { branchId: activeBranch }
      : undefined
  const sessionId = store ? store.createSession(opts.bookName, { book: opts.bookName }) : 'mem'
  const recorder = new SessionRecorder(store, sessionId)
  onRecorder(recorder)
  recorder.add(sessionStartEvent(opts.bookName))
  const baseLen = history.length
  const ctx = buildChatContext(opts.bookRoot, opts.chapter, { userDataPath: opts.userDataPath })
  const sys = chatSystem(ctx)
  // P3 血缘：注入快照指纹（settings/正文预览/技巧包索引）——turn 内登记 settings/snapshot
  // + revision/ref + skills/snapshot。三处 digest 与可见侧收集器 visibleInjections
  // （prompts/chat.ts）严格同源：同一 ctx 字段、同一 digest16——「模型可见 ⟺ 已记录」的命门
  const settingsDigest = digest16(ctx.settings)
  const revisionDigest = ctx.currentChapter ? digest16(ctx.currentChapter) : undefined
  const skillsDigest = ctx.skillsIndex ? digest16(ctx.skillsIndex) : undefined
  // #3b 根修：push 必须在 buildChatContext 之后——buildChatContext 读文件可能耗时，
  // 期间若作者发起新对话（并发），旧历史 push 会与新消息错位（交替 user 被打乱）。
  // 先读文件后 push，保证 history 修改点紧邻 generate，window 最小。
  const seqs: ChatSeqLedger = {
    msgSeqs,
    pendingMsgSeqs: [],
    commitPendingMsgSeqs(range) {
      if (!range) return
      for (const idx of this.pendingMsgSeqs) {
        this.msgSeqs.push(typeof idx === 'number' ? [range.first + idx] : idx.map((i) => range.first + i))
      }
      this.pendingMsgSeqs = []
    },
  }
  if (!opts.regenerate) {
    // F1-P4：regenerate 复用已有 user 消息（历史恢复已含），不再 push/写新 user 事件；
    // 普通回合带活跃分支归属（Z-P1-2 写侧谱系——regenerate 后的续聊 user 进组）
    history.push({ role: 'user', content: opts.message ?? '' })
    seqs.pendingMsgSeqs.push(recorder.add(userMessageEvent(opts.message ?? '', opts.chapter, turnBranch)))
  }

  emit(opts, { type: 'chat_start' })
  return { history, sys, recorder, baseLen, turnBranch, digests: { settings: settingsDigest, revision: revisionDigest, skills: skillsDigest }, seqs }
}
