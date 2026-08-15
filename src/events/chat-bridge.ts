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
import type { ChatEvent } from './types.js'
import { foldSurface, type SurfaceNode } from './projection.js'
import type { SessionStore, NewEvent } from './store.js'

// ── 事件构造辅助 ──────────────────────────────────

export function sessionStartEvent(book: string): NewEvent {
  return { type: 'session/start', data: { book } }
}

export function sessionEndEvent(reason: string): NewEvent {
  return { type: 'session/end', data: { reason } }
}

export function turnStartEvent(turn: number): NewEvent {
  return { type: 'turn/start', turn, data: {} }
}

export function turnEndEvent(turn: number, reason: string): NewEvent {
  return { type: 'turn/end', turn, data: { reason } }
}

export function userMessageEvent(message: string, chapter?: number): NewEvent {
  return {
    type: 'user/message',
    data: chapter === undefined ? { message } : { message, chapter },
    surfaceOp: 'append',
  }
}

export function assistantMessageEvent(
  message: string | ContentBlock[],
  usage?: { inputTokens: number; outputTokens: number },
  stopReason?: string,
  sourceSeqs?: number[],
): NewEvent {
  const data: Record<string, unknown> = { message }
  if (usage) data['usage'] = usage
  if (stopReason) data['stopReason'] = stopReason
  return { type: 'assistant/message', data, surfaceOp: 'append', ...(sourceSeqs ? { sourceSeqs } : {}) }
}

export function toolCallEvent(callId: string, name: string, args: unknown): NewEvent {
  return { type: 'tool/call', data: { callId, name, arguments: args } }
}

export function toolResultEvent(callId: string, content: string, isError?: boolean): NewEvent {
  return {
    type: 'tool/result',
    data: isError === undefined ? { callId, content } : { callId, content, isError },
    surfaceOp: 'append',
  }
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

  constructor(store: SessionStore | null, sessionId: string) {
    this.store = store
    this.sessionId = sessionId
  }

  /** 记录事件，返回该事件在本批次内的序号（0-based；flush 后 first + idx = seq） */
  add(ev: NewEvent): number {
    this.pending.push(ev)
    return this.pending.length - 1
  }

  /** 落库当前批 → 该批事件 seq 区间 [first, last]；无 store 或空批 → null */
  flush(): { first: number; last: number } | null {
    if (!this.store || this.pending.length === 0) return null
    const n = this.pending.length
    const before = this.store.lastSeq()
    // P3 血缘：sourceSeqs 以「批内序号」传入（0-based，同批前驱引用），落库前转全局 seq
    const resolved = this.pending.map((ev, _idx) => {
      if (ev.sourceSeqs && ev.sourceSeqs.length > 0) {
        return { ...ev, sourceSeqs: ev.sourceSeqs.map((s) => before + 1 + s) }
      }
      return ev
    })
    this.store.appendEvents(this.sessionId, resolved)
    this.pending = []
    const range = { first: before + 1, last: before + n }
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
   * 会话收尾：追加 session/end 并落库。
   * @param shadow 若给定被裁消息的 seq 列表，写 compaction/start + replace 遮蔽 + compaction/end
   */
  close(reason: string, shadowSeqs?: number[]): void {
    this.pending.push(sessionEndEvent(reason))
    this.flush()
    if (!this.store || !shadowSeqs || shadowSeqs.length === 0) return
    // 遮蔽区间：被裁 seq 应连续（每回合事件连续写）；不连续则逐段遮蔽
    const sorted = [...shadowSeqs].sort((a, b) => a - b)
    const segs: Array<{ start: number; end: number }> = []
    let segStart = sorted[0]!;
    let segEnd = sorted[0]!;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]! === segEnd + 1) {
        segEnd = sorted[i]!
      } else {
        segs.push({ start: segStart, end: segEnd })
        segStart = sorted[i]!;
        segEnd = sorted[i]!;
      }
    }
    segs.push({ start: segStart, end: segEnd })
    const now = Date.now()
    for (const s of segs) {
      this.store.appendEvents(this.sessionId, [
        { type: 'compaction/start', data: { count: s.end - s.start + 1 } },
        {
          type: 'compaction/end',
          data: { reason },
          surfaceOp: 'replace',
          shadowStart: s.start,
          shadowEnd: s.end,
          sourceSeqs: Array.from({ length: s.end - s.start + 1 }, (_, i) => s.start + i),
        },
      ])
    }
    void now;
  }
}

