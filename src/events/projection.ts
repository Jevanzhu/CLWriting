/**
 * F1 surface 投影纯函数（F1 方案 §四，照抄 dsh surface.ts 语义裁剪）。
 *
 * 投影语义：
 * - 只有 user/message、assistant/message、tool/result 三类可上 surface（SURFACE_EVENT_TYPES）
 * - append：追加到可见序列尾；replace：新节点遮蔽闭区间 [start,end] 内全部旧节点
 *   （旧事件仍在表中，只标记 shadowed——人类抄本从 append 起源事件读全量）
 * - user/message → data 原样（framing 归生产者）
 * - assistant/message 空 content → 跳过（usage 壳不进抄本；判空口径 = 剔 reasoning 后无 payload）
 * - tool/result → tool_result 消息（连续节点在 deriveMessages 合并为一条 user 消息）
 *
 * 纯函数，不依赖 DB——单测直接喂事件数组。
 */
import type { ContentBlock } from '../ai/provider/types.js'
import type { ChatEvent, EventType } from './types.js'
import {
  SURFACE_EVENT_TYPES,
  SESSION_END_REASONS,
  STEP_END_REASONS,
  TURN_END_REASONS,
  GOAL_OPERATIONS,
} from './types.js'

/** 投影出的表面节点（带 seq，供 replace 遮蔽引用） */
export interface SurfaceNode {
  seq: number
  kind: 'user-text' | 'assistant' | 'tool-result'
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  /** 该节点是否被后续 replace 遮蔽（仍在表中，仅投影不可见） */
  shadowed: boolean
  /** tool-result 节点的原始载荷（deriveMessages 合并用） */
  tool?: { callId: string; content: string; isError?: boolean }
}

/** 按 seq 升序重放事件（prefixSeq 时只处理 seq ≤ prefixSeq 的前缀） */
export function sortEvents(events: ChatEvent[]): ChatEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq)
}

/** assistant 消息判空口径：剔 reasoning 后无 payload（与 sanitizeHistory 一致） */
function assistantHasPayload(message: string | unknown[]): boolean {
  if (typeof message === 'string') return message.trim() !== ''
  const blocks = message as ContentBlock[]
  return blocks.some((b) => b.type === 'tool_use' || (b.type === 'text' && b.text.trim() !== ''))
}

/**
 * 从事件流重放前缀 → 可见表面节点序列（含被遮蔽标记）。
 * 纯函数；events 不必有序（内部排序）。
 */
export function foldSurface(events: ChatEvent[], prefixSeq?: number): SurfaceNode[] {
  const sorted = sortEvents(events).filter((e) => prefixSeq === undefined || e.seq <= prefixSeq)
  const visible: SurfaceNode[] = []

  for (const ev of sorted) {
    if (ev.type === 'user/message') {
      visible.push({
        seq: ev.seq,
        kind: 'user-text',
        role: 'user',
        content: String(ev.data['message'] ?? ''),
        shadowed: false,
      })
      continue
    }
    if (ev.type === 'assistant/message') {
      const msg = ev.data['message']
      if (typeof msg !== 'string' && !Array.isArray(msg)) continue // 损坏载荷不投影
      if (!assistantHasPayload(msg as string | unknown[])) continue // usage 壳不进抄本
      visible.push({
        seq: ev.seq,
        kind: 'assistant',
        role: 'assistant',
        content: msg as string | ContentBlock[],
        shadowed: false,
      })
      continue
    }
    if (ev.type === 'tool/result') {
      visible.push({
        seq: ev.seq,
        kind: 'tool-result',
        role: 'user',
        content: [],
        shadowed: false,
        tool: {
          callId: String(ev.data['callId'] ?? ''),
          content: String(ev.data['content'] ?? ''),
          isError: ev.data['isError'] === true,
        },
      })
      continue
    }
    if (ev.type === 'compaction/end') {
      // replace 遮蔽：闭区间 [shadowStart, shadowEnd] 内已可见节点标 shadowed；
      // Y-P2-2：携带存档内容（data.message）时在被遮蔽区间原位取代——投影语义与内存
      // 历史 [存档, ...toKeep] 一致（此前存档只在内存，跨重启恢复丢被压上下文）
      const start = ev.shadowStart
      const end = ev.shadowEnd
      if (start !== undefined && end !== undefined && start <= end) {
        let insertAt = visible.length
        let inserted = false
        for (let i = 0; i < visible.length; i++) {
          const n = visible[i]!
          if (n.seq >= start && n.seq <= end) {
            n.shadowed = true
            if (!inserted) {
              insertAt = i
              inserted = true
            }
          } else if (n.seq > end && !inserted) {
            insertAt = i
            inserted = true
          }
        }
        const msg = ev.data['message']
        if (typeof msg === 'string' && msg.trim() !== '') {
          visible.splice(insertAt, 0, {
            seq: ev.seq,
            kind: 'user-text',
            role: 'user',
            content: msg,
            shadowed: false,
          })
        }
      }
      continue
    }
    // 其他事件（边界类/tool/call）不进 surface
  }

  return visible
}

/**
 * 投影 → ChatMsg[]（可直接喂 sanitizeHistory/generate）。
 * 连续 tool/result 节点合并为一条 user(tool_result blocks) 消息，与内存版历史等价。
 */
export function deriveMessages(events: ChatEvent[], prefixSeq?: number): Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }> {
  const nodes = foldSurface(events, prefixSeq).filter((n) => !n.shadowed)
  const out: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }> = []
  let pendingTool: ContentBlock[] = []

  const flushTool = (): void => {
    if (pendingTool.length === 0) return
    out.push({ role: 'user', content: pendingTool })
    pendingTool = []
  }

  for (const n of nodes) {
    if (n.kind === 'tool-result') {
      pendingTool.push({
        type: 'tool_result',
        toolUseId: n.tool!.callId,
        content: n.tool!.content,
        isError: n.tool!.isError,
      })
      continue
    }
    flushTool()
    out.push({ role: n.role, content: n.content })
  }
  flushTool()
  return out
}

/**
 * 校验链（F1 §四「校验链」，开发期 fail loud）：
 * - 非 surface 事件禁带 surfaceOp；surface 事件必须带 surfaceOp
 * - replace 的 shadowStart/shadowEnd 必须已可见且 start≤end
 * - sourceSeqs 必须完整覆盖每个被遮蔽节点、全部早于当前 seq、无重复
 * - seq 单调递增无重复
 * 返回问题列表（空 = 通过）。
 */
export interface ValidationIssue {
  seq: number
  message: string
}

export function validateEventStream(events: ChatEvent[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const sorted = sortEvents(events)
  const seenSeqs = new Set<number>()
  const visibleSeqs = new Set<number>()
  let lastSeq = -1

  for (const ev of sorted) {
    if (ev.seq <= lastSeq) issues.push({ seq: ev.seq, message: 'seq 未严格递增（重复或乱序）' })
    if (seenSeqs.has(ev.seq)) issues.push({ seq: ev.seq, message: 'seq 重复' })
    seenSeqs.add(ev.seq)
    lastSeq = ev.seq

    const isSurfaceType = SURFACE_EVENT_TYPES.has(ev.type as EventType)
    // compaction/end 是 replace 载体（遮蔽旧节点），允许且必须带 surfaceOp='replace'
    const isReplaceCarrier = ev.type === 'compaction/end'
    if (!isSurfaceType && !isReplaceCarrier && ev.surfaceOp !== undefined) {
      issues.push({ seq: ev.seq, message: '非 surface 事件禁带 surfaceOp' })
    }
    if (isSurfaceType && ev.surfaceOp === undefined) {
      issues.push({ seq: ev.seq, message: 'surface 事件必须带 surfaceOp' })
    }
    if (isReplaceCarrier && ev.surfaceOp !== 'replace') {
      issues.push({ seq: ev.seq, message: 'compaction/end 必须带 surfaceOp=replace' })
    }

    // F2：结构化终止原因校验——turn/end、step/end、session/end 的 reason 必须是受控词表
    const reason = ev.data['reason']
    if (ev.type === 'turn/end' && typeof reason === 'string' && !(TURN_END_REASONS as readonly string[]).includes(reason)) {
      issues.push({ seq: ev.seq, message: 'turn/end 非法终止原因: ' + reason })
    }
    if (ev.type === 'step/end' && typeof reason === 'string' && !(STEP_END_REASONS as readonly string[]).includes(reason)) {
      issues.push({ seq: ev.seq, message: 'step/end 非法终止原因: ' + reason })
    }
    if (ev.type === 'session/end' && typeof reason === 'string' && !(SESSION_END_REASONS as readonly string[]).includes(reason)) {
      issues.push({ seq: ev.seq, message: 'session/end 非法终止原因: ' + reason })
    }

    // F5：goal/change 的 operation 受控词表 + 快照形状；todo/write 整表形状
    if (ev.type === 'goal/change') {
      const op = ev.data['operation']
      if (typeof op === 'string' && !(GOAL_OPERATIONS as readonly string[]).includes(op)) {
        issues.push({ seq: ev.seq, message: 'goal/change 非法 operation: ' + op })
      }
      const goal = ev.data['goal']
      if (!goal || typeof goal !== 'object') {
        issues.push({ seq: ev.seq, message: 'goal/change 缺 goal 快照' })
      } else {
        const g = goal as Record<string, unknown>
        if (typeof g['id'] !== 'string' || typeof g['title'] !== 'string') {
          issues.push({ seq: ev.seq, message: 'goal/change 快照缺 id/title' })
        }
        if (g['state'] !== 'active' && g['state'] !== 'paused' && g['state'] !== 'blocked' && g['state'] !== 'complete') {
          issues.push({ seq: ev.seq, message: 'goal/change 快照非法 state' })
        }
      }
    }
    if (ev.type === 'todo/write') {
      const todos = ev.data['todos']
      if (!Array.isArray(todos)) {
        issues.push({ seq: ev.seq, message: 'todo/write 缺 todos 数组' })
      } else {
        for (const t of todos) {
          const td = t as Record<string, unknown> | null
          if (!td || typeof td['text'] !== 'string' || (td['state'] !== 'pending' && td['state'] !== 'in_progress' && td['state'] !== 'completed')) {
            issues.push({ seq: ev.seq, message: 'todo/write 含非法条目' })
            break
          }
        }
      }
    }

    // G2-1：快照登记类事件同载荷形状 {scope, digest}——settings/snapshot 与 skills/snapshot 同构校验
    if (ev.type === 'settings/snapshot' || ev.type === 'skills/snapshot') {
      if (typeof ev.data['scope'] !== 'string' || typeof ev.data['digest'] !== 'string') {
        issues.push({ seq: ev.seq, message: ev.type + ' 载荷缺 scope/digest 字符串字段' })
      }
    }

    if (ev.type === 'compaction/end') {
      const start = ev.shadowStart
      const end = ev.shadowEnd
      if (start === undefined || end === undefined) {
        issues.push({ seq: ev.seq, message: 'compaction/end 缺 shadowStart/shadowEnd' })
      } else if (start > end) {
        issues.push({ seq: ev.seq, message: 'shadowStart > shadowEnd' })
      } else {
        // 被遮蔽节点必须已可见
        for (let s = start; s <= end; s++) {
          if (!visibleSeqs.has(s)) issues.push({ seq: ev.seq, message: '遮蔽区间含未可见 seq ' + s })
        }
      }
      // sourceSeqs 覆盖校验
      const srcs = ev.sourceSeqs ?? []
      const dup = srcs.filter((x, i) => srcs.indexOf(x) !== i)
      if (dup.length > 0) issues.push({ seq: ev.seq, message: 'sourceSeqs 有重复: ' + dup.join(',') })
      for (const s of srcs) {
        if (s >= ev.seq) issues.push({ seq: ev.seq, message: 'sourceSeqs 含不小于当前 seq 的 ' + s })
      }
      if (start !== undefined && end !== undefined) {
        for (let s = start; s <= end; s++) {
          if (!srcs.includes(s)) issues.push({ seq: ev.seq, message: 'sourceSeqs 未覆盖被遮蔽节点 ' + s })
        }
      }
      // replace 后 visible 更新：移除被遮蔽节点
      for (let s = start ?? 0; s <= (end ?? -1); s++) visibleSeqs.delete(s)
      // Y-P2-2：携带存档的 compaction/end 本身成为可见节点（投影在区间原位插入存档）
      if (typeof ev.data['message'] === 'string' && (ev.data['message'] as string).trim() !== '') {
        visibleSeqs.add(ev.seq)
      }
    }

    // 本事件成为可见节点（surface 且带 surfaceOp 时加入）
    if (isSurfaceType && ev.surfaceOp !== undefined) {
      visibleSeqs.add(ev.seq)
    }
  }

  return issues
}
