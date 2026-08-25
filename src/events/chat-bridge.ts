/**
 * F1-P1 对话助手历史 ↔ 事件桥接（chat.ts 接入层）。
 *
 * 职责：
 * - 事件构造辅助（session/turn/user/assistant/tool 事件）
 * - loadHistoryWithSeqs：从事件恢复 ChatMsg[] + 「每条消息 → 事件 seq」映射
 *   （压缩遮蔽需要精确 seq 区间，跨会话重建）
 * - SessionRecorder：会话录制器——回合级 flush（每回合一个事务），
 *   压缩（trimHistory 截断）时把被裁消息的 seq 区间用 replace 遮蔽，
 *   人类抄本（append 事件）全量保留，模型可见投影只含未遮蔽节点。
 */
import type { ChatMsg, ContentBlock } from '../ai/provider/types.js'
import type { ChatEvent, SessionEndReason, TurnEndReason } from './types.js'
import { SURFACE_EVENT_TYPES } from './types.js'
import { foldSurface, assistantMessageVisible, type SurfaceNode } from './projection.js'
import type { SessionStore, NewEvent } from './store.js'
import { registerActiveChatSession, unregisterActiveChatSession } from './store.js'

// ── 事件构造辅助 ──────────────────────────────────

export function sessionStartEvent(book: string): NewEvent {
  return { type: 'session/start', data: { book } }
}

export function sessionEndEvent(reason: SessionEndReason): NewEvent {
  return { type: 'session/end', data: { reason } }
}

export function turnStartEvent(turn: number): NewEvent {
  return { type: 'turn/start', turn, data: {} }
}

export function turnEndEvent(turn: number, reason: TurnEndReason): NewEvent {
  return { type: 'turn/end', turn, data: { reason } }
}

export function userMessageEvent(
  message: string,
  chapter?: number,
  branch?: { parentSeq?: number; branchId?: string },
): NewEvent {
  const data: Record<string, unknown> = chapter === undefined ? { message } : { message, chapter }
  if (branch?.parentSeq !== undefined) data['parentSeq'] = branch.parentSeq
  if (branch?.branchId) data['branchId'] = branch.branchId
  return { type: 'user/message', data, surfaceOp: 'append' }
}

export function assistantMessageEvent(
  message: string | ContentBlock[],
  usage?: { inputTokens: number; outputTokens: number },
  stopReason?: string,
  sourceSeqs?: number[],
  branch?: { parentSeq?: number; branchId?: string },
): NewEvent {
  const data: Record<string, unknown> = { message }
  if (usage) data['usage'] = usage
  if (stopReason) data['stopReason'] = stopReason
  // F1-P4/Z-P1-2/R63-1：parentSeq 两种来源——变体根（regenerate 首条，锚定触发 user）
  // 与续聊链边（活跃分支下的普通回合，前驱消息首 seq——补 selectBranch/selectBranchTo
  // 祖先链的可达性）；线性回合不传，行为不变
  if (branch?.parentSeq !== undefined) data['parentSeq'] = branch.parentSeq
  if (branch?.branchId) data['branchId'] = branch.branchId
  return { type: 'assistant/message', data, surfaceOp: 'append', ...(sourceSeqs ? { sourceSeqs } : {}) }
}

export function toolCallEvent(callId: string, name: string, args: unknown): NewEvent {
  return { type: 'tool/call', data: { callId, name, arguments: args } }
}

export function toolResultEvent(
  callId: string,
  content: string,
  isError?: boolean,
  branch?: { parentSeq?: number; branchId?: string },
): NewEvent {
  const data: Record<string, unknown> = isError === undefined ? { callId, content } : { callId, content, isError }
  // F1-P4：分支元数据与 userMessageEvent 同模式（不传时行为不变——普通回合零影响）
  if (branch?.parentSeq !== undefined) data['parentSeq'] = branch.parentSeq
  if (branch?.branchId) data['branchId'] = branch.branchId
  return { type: 'tool/result', data, surfaceOp: 'append' }
}

// ── 恢复历史 + 消息→seq 映射 ───────────────────────

export interface RestoredHistory {
  /** 投影出的 ChatMsg[]（未遮蔽节点，与内存版等价） */
  msgs: ChatMsg[]
  /** 每条 msgs[i] 对应的 surface 节点 seq 列表（并行数组，压缩遮蔽用） */
  seqsPerMsg: number[][]
}

/**
 * 从事件流恢复历史 + 重建消息→seq 映射。
 * 合并规则与 deriveMessages 一致：连续 tool-result 节点合成一条 user(tool_result blocks)。
 */
export function loadHistoryWithSeqs(events: ChatEvent[]): RestoredHistory {
  const nodes = foldSurface(events).filter((n) => !n.shadowed)
  const msgs: ChatMsg[] = []
  const seqsPerMsg: number[][] = []
  // tool-result 单独累积（连续合成一条 user 消息）；非 tool-result 单独成消息
  let curTool: SurfaceNode[] = []

  const flushTool = (): void => {
    if (curTool.length === 0) return
    const blocks: ContentBlock[] = curTool.map((n) => ({
      type: 'tool_result',
      toolUseId: n.tool!.callId,
      content: n.tool!.content,
      isError: n.tool!.isError,
    }))
    msgs.push({ role: 'user', content: blocks })
    seqsPerMsg.push(curTool.map((n) => n.seq))
    curTool = []
  };

  for (const n of nodes) {
    if (n.kind === 'tool-result') {
      curTool.push(n)
      continue
    }
    flushTool()
    msgs.push({ role: n.role, content: n.content })
    seqsPerMsg.push([n.seq])
  }
  flushTool()
  return { msgs, seqsPerMsg }
}

// ── 会话录制器 ─────────────────────────────────────

/**
 * 会话录制器：收集事件 → 回合级 flush（每回合一个事务）。
 * store 为 null（无 userDataPath）时退化为纯内存记录（flush 返回 null）。
 */
export class SessionRecorder {
  private pending: NewEvent[] = []
  private store: SessionStore | null
  private sessionId: string
  /** 已落库批次区间（失败回滚时遮蔽本会话全部已写事件用） */
  private flushedRanges: Array<{ first: number; last: number }> = []
  /** 本批内 surface 类事件（user/assistant/tool_result）的批次内序号 */
  private pendingSurfaceIdx: number[] = []
  /** 本会话全部 surface 事件的绝对 seq（失败遮蔽唯一合法口径——遮蔽区间只许盖曾可见节点） */
  private surfaceSeqs: number[] = []
  /** close 已执行（幂等） */
  private ended = false
  /** R62-10：close 首 flush 失败（session/end 未落库）——finally 不 dispose，
   *  保留 store 引用与活跃登记供重试；调用方放弃重试时其 finally 的 dispose() 兜底注销 */
  private closeFlushFailed = false

  constructor(store: SessionStore | null, sessionId: string) {
    this.store = store
    this.sessionId = sessionId
    // Y-P1-1：登记活跃会话——孤儿修复（重开库时）跳过进行中的会话，防虚假 session/end
    if (store) registerActiveChatSession(sessionId)
  }

  /** 记录事件，返回该事件在本批次内的序号（0-based；flush 后 first + idx = seq） */
  add(ev: NewEvent): number {
    // R62-11：空载荷 assistant/message（usage 壳）不记遮蔽位——foldSurface 对其
    // continue（该 seq 永不成为可见节点），计入会让「遮蔽区间只许盖曾可见节点」
    // 契约在 validateEventStream 侧误报。user/message 与 tool/result 无条件可见不需判。
    if (SURFACE_EVENT_TYPES.has(ev.type)) {
      if (ev.type !== 'assistant/message' || assistantMessageVisible(ev.data)) {
        this.pendingSurfaceIdx.push(this.pending.length)
      }
    }
    this.pending.push(ev)
    return this.pending.length - 1
  }

  /** 落库当前批 → 该批事件 seq 区间 [first, last]；无 store 或空批 → null */
  flush(): { first: number; last: number } | null {
    if (!this.store || this.pending.length === 0) return null
    // AA-P3-7：血缘 seq 不再用 lastSeq()+批内序号推算（多窗口并发写事件库时 lastSeq()
    // 与落库之间无原子性，可能错链到别的窗口）——INSERT RETURNING 取数据库真实分配的
    // seq，sourceSeqs 批内索引在同一事务内回写解析。
    const seqs = this.store.appendEventsResolveLineage(this.sessionId, this.pending)
    this.pending = []
    const range = { first: seqs[0]!, last: seqs[seqs.length - 1]! }
    this.flushedRanges.push(range)
    for (const i of this.pendingSurfaceIdx) this.surfaceSeqs.push(range.first + i)
    this.pendingSurfaceIdx = []
    return range
  }

  /** 本会话已落库事件的全部 seq（失败路径遮蔽用） */
  allSessionSeqs(): number[] {
    const out: number[] = []
    for (const r of this.flushedRanges) {
      for (let s = r.first; s <= r.last; s++) out.push(s)
    }
    return out
  }

  /**
   * GG-P2-1：失败收尾遮蔽本会话全部消息事件。此前失败路径写 `close(reason, allSessionSeqs())`：
   * ① 遮蔽列表取 close 内部 flush **前**的快照——pending 里未落库的半截 user/assistant
   *   在 close 内才拿到 seq、不在遮蔽列表里，audit 重放出模型从未成功产出的「幽灵消息」
   *   （破坏「模型可见⟺已记录」）；② 即便先 flush，allSessionSeqs() 也混入 turn/start、
   *   快照等结构性事件——遮蔽区间只许盖「曾可见」节点（validateEventStream 契约）。
   * 故按 surface 口径（user/assistant/tool_result）遮蔽：先 flush 让 pending 消息拿到 seq，
   * 再遮蔽全会话消息 seq；结构事件不遮（投影本就无消息内容，审计保留完整骨架），
   * session/end 由 close 随后分配新 seq、不进遮蔽（保留失败终态）。
   */
  closeMaskingAll(reason: SessionEndReason): number | null {
    this.flush()
    return this.close(reason, [...this.surfaceSeqs])
  }

  /**
   * 会话收尾：追加 session/end 并落库（幂等——重复调用只生效一次）。
   * @param shadow 若给定被裁消息的 seq 列表，写 compaction/start + replace 遮蔽 + compaction/end
   * @param summary Y-P2-2：压缩存档内容（checkpoint 包裹后的 user 消息原文）——并入首个
   *  compaction/end 载荷，投影时在被遮蔽区间原位取代（「模型可见⟺已记录」，跨重启带回存档）。
   * @returns 存档节点 seq（= 携带 message 的 compaction/end 事件 seq）；无存档/无落库 → null
   */
  close(reason: SessionEndReason, shadowSeqs?: number[], summary?: string): number | null {
    if (this.ended) return null
    this.ended = true
    let archiveSeq: number | null = null
    try {
      const endEv = sessionEndEvent(reason)
      this.pending.push(endEv)
      try {
        this.flush()
      } catch (e) {
        // R62-10：session/end 尚未落库——回滚幂等闸保留 close 重试性（瞬态 SQLITE_BUSY
        // 超时/磁盘满恢复后重试可补 session/end，不再只能依赖孤儿修复事后补 interrupted
        // 与真实终止原因失真）；同时撤回本侧压入的 end 事件防重试双写。flush 成功后的
        // 后续步骤失败不回滚——session/end 已在库，重试会写第二个 end。
        this.ended = false
        if (this.pending[this.pending.length - 1] === endEv) this.pending.pop()
        this.closeFlushFailed = true
        throw e
      }
      if (!this.store || !shadowSeqs || shadowSeqs.length === 0) return null
      // 遮蔽区间：被裁 seq 应连续（每回合事件连续写）；不连续则逐段遮蔽
      const sorted = [...shadowSeqs].sort((a, b) => a - b)
      const segs: Array<{ start: number; end: number }> = []
      let segStart = sorted[0]!
      let segEnd = sorted[0]!
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]! === segEnd + 1) {
          segEnd = sorted[i]!
        } else {
          segs.push({ start: segStart, end: segEnd })
          segStart = sorted[i]!
          segEnd = sorted[i]!
        }
      }
      segs.push({ start: segStart, end: segEnd })
      // Y-P2-2：存档只在首个遮蔽段携带（一张累计存档取代全部被压内容）
      let carried = false
      for (const s of segs) {
        const carry = summary !== undefined && !carried
        if (carry) carried = true
        // RB-IF-P1-2：archiveSeq 取数据库真实分配的 seq（appendEvents INSERT RETURNING），
        // 不再 lastSeq()+2 推算——多窗口并发写事件库时推算可错链到别窗事件（AA-P3-7 同理）
        const seqs = this.store.appendEvents(this.sessionId, [
          { type: 'compaction/start', data: { count: s.end - s.start + 1 } },
          {
            type: 'compaction/end',
            ...(carry && summary !== undefined
              ? { data: { reason, message: summary } }
              : { data: { reason } }),
            surfaceOp: 'replace',
            shadowStart: s.start,
            shadowEnd: s.end,
            sourceSeqs: Array.from({ length: s.end - s.start + 1 }, (_, i) => s.start + i),
          },
        ])
        if (carry) archiveSeq = seqs[1]! // 批内第 2 个 = compaction/end（存档节点）
      }
    } finally {
      // Y-P1-1：收尾注销活跃登记（异常路径由调用方 finally 调 dispose 兜底）；
      // R62-10：首 flush 失败路径不 dispose——保留 store/登记，close 重试才真正可落库
      if (this.closeFlushFailed) this.closeFlushFailed = false
      else this.dispose()
    }
    return archiveSeq
  }

  /** 注销活跃登记（幂等；不写事件）——runChat finally 兜底防异常路径漏注销 */
  dispose(): void {
    if (this.store) unregisterActiveChatSession(this.sessionId)
    this.store = null
  }
}

