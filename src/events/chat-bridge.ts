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
import { foldSurface, type SurfaceNode } from './projection.js'
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
  // F1-P4/Z-P1-2：parentSeq 仅变体根需要（regenerate 首条）；续聊进组只带 branchId
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
  /** close 已执行（幂等） */
  private ended = false

  constructor(store: SessionStore | null, sessionId: string) {
    this.store = store
    this.sessionId = sessionId
    // Y-P1-1：登记活跃会话——孤儿修复（重开库时）跳过进行中的会话，防虚假 session/end
    if (store) registerActiveChatSession(sessionId)
  }

  /** 记录事件，返回该事件在本批次内的序号（0-based；flush 后 first + idx = seq） */
  add(ev: NewEvent): number {
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
      this.pending.push(sessionEndEvent(reason))
      this.flush()
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
        const before = this.store.lastSeq()
        this.store.appendEvents(this.sessionId, [
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
        if (carry) archiveSeq = before + 2
      }
    } finally {
      // Y-P1-1：收尾注销活跃登记（异常路径由调用方 finally 调 dispose 兜底）
      this.dispose()
    }
    return archiveSeq
  }

  /** 注销活跃登记（幂等；不写事件）——runChat finally 兜底防异常路径漏注销 */
  dispose(): void {
    if (this.store) unregisterActiveChatSession(this.sessionId)
    this.store = null
  }
}

