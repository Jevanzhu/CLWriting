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

/** 按 seq 升序重放事件（prefixSeq 时只处理 seq ≤ prefixSeq 的前缀）。
 *  B2（2026-08-24 内存闸）：输入已有序（SQL ORDER BY / 上游已排序——投影链常态）时
 *  O(n) 检测后零拷贝直返，乱序输入回退拷贝排序（纯函数语义不变；调用方只读返回值）。 */
export function sortEvents(events: ChatEvent[]): ChatEvent[] {
  let sorted = true
  for (let i = 1; i < events.length; i++) {
    if (events[i - 1]!.seq > events[i]!.seq) {
      sorted = false
      break
    }
  }
  if (sorted) return events
  return [...events].sort((a, b) => a.seq - b.seq)
}

/** assistant 消息判空口径：剔 reasoning 后无 payload（与 sanitizeHistory 一致） */
function assistantHasPayload(message: string | unknown[]): boolean {
  if (typeof message === 'string') return message.trim() !== ''
  const blocks = message as ContentBlock[]
  return blocks.some((b) => b.type === 'tool_use' || (b.type === 'text' && b.text.trim() !== ''))
}

/** R62-11：assistant/message 事件是否会投影为可见节点（载荷形别合法 + 非空壳）。
 *  foldSurface 与 chat-bridge 记遮蔽位共用同口径——「遮蔽区间只许盖曾可见节点」
 *  契约要求录制侧与投影侧判同一谓词（空 usage 壳录制侧计入遮蔽位会让
 *  closeMaskingAll 产出的数据流过 validateEventStream 时误报「含未可见 seq」）。 */
export function assistantMessageVisible(data: Record<string, unknown>): boolean {
  const msg = data['message']
  if (typeof msg !== 'string' && !Array.isArray(msg)) return false // 损坏载荷不投影
  return assistantHasPayload(msg)
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
      if (!assistantMessageVisible(ev.data)) continue // 损坏载荷/usage 壳不进抄本
      visible.push({
        seq: ev.seq,
        kind: 'assistant',
        role: 'assistant',
        content: ev.data['message'] as string | ContentBlock[],
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
      // R27-106（二十七轮）：插入锚按 seq 优先级判定，不再依赖数组位序——visible 数组
      // 本应 seq 升序，但此前存档插在中部后（存档 seq 大于其后的保留节点 seq）数组已
      // 失序：原单遍扫描「先到先得」会让 seq>end 节点（数组在前）抢走锚点，新存档反插
      // 到旧存档之前（原位取代被数组位序击穿，正确性只靠无断言的生产不变量）。两候选
      // 独立收集后按 seq 取舍：区间内节点 seq ≤ end < 区间后节点 seq → 区间内锚恒优先；
      // 区间内无节点回退「区间后首个」（P-15 区间语义）、全无候选追加尾部（P-15 兜底），
      // 两锁定行为不变。
      const start = ev.shadowStart
      const end = ev.shadowEnd
      if (start !== undefined && end !== undefined && start <= end) {
        let firstShadowedAt = -1
        let firstAfterAt = -1
        for (let i = 0; i < visible.length; i++) {
          const n = visible[i]!
          if (n.seq >= start && n.seq <= end) {
            n.shadowed = true
            if (firstShadowedAt === -1) firstShadowedAt = i
          } else if (n.seq > end && firstAfterAt === -1) {
            firstAfterAt = i
          }
        }
        const insertAt = firstShadowedAt !== -1 ? firstShadowedAt : firstAfterAt !== -1 ? firstAfterAt : visible.length
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
    // R26-103（二十六轮）：同一坏事件的「未递增 + 重复」双告警合并为一条——重复 seq 必然
    // 也 ≤ 前一 seq，原先两条 issue 叠发（同一病灶两行噪音）；现重复只报「seq 重复」，
    // 非重复的乱序才报「未严格递增」。
    if (seenSeqs.has(ev.seq)) {
      issues.push({ seq: ev.seq, message: 'seq 重复' })
    } else {
      if (ev.seq <= lastSeq) issues.push({ seq: ev.seq, message: 'seq 未严格递增（乱序）' })
      seenSeqs.add(ev.seq)
    }
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
        // R62-31：被遮蔽节点必须已可见——改对 visibleSeqs 做区间包含判断 O(visible)。
        // 此前逐 seq 扫 [start,end]：脏数据 shadowEnd=1e9 会线性扫十亿次挂死校验链。
        const inRange: number[] = []
        for (const s of visibleSeqs) if (s >= start && s <= end) inRange.push(s)
        if (inRange.length !== end - start + 1) {
          issues.push({
            seq: ev.seq,
            message: `遮蔽区间 [${start},${end}] 含未可见 seq（区间 ${end - start + 1} 个，可见仅 ${inRange.length} 个）`,
          })
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
        // R62-31 同款 O(visible)：只对区间内实际可见的 seq 报未覆盖（区间内不可见的
        // 已由上一条「含未可见 seq」报过，脏数据下不重复扫十亿区间）
        const srcSet = new Set(srcs)
        for (const s of visibleSeqs) {
          if (s >= start && s <= end && !srcSet.has(s)) {
            issues.push({ seq: ev.seq, message: 'sourceSeqs 未覆盖被遮蔽节点 ' + s })
          }
        }
      }
      // replace 后 visible 更新：移除被遮蔽节点（R62-31 同款 O(visible)，不逐 seq 扫区间）
      {
        const st = start ?? 0
        const en = end ?? -1
        for (const s of [...visibleSeqs]) {
          if (s >= st && s <= en) visibleSeqs.delete(s)
        }
      }
      // Y-P2-2：携带存档的 compaction/end 本身成为可见节点（投影在区间原位插入存档）
      if (typeof ev.data['message'] === 'string' && (ev.data['message'] as string).trim() !== '') {
        visibleSeqs.add(ev.seq)
      }
    }

    // 本事件成为可见节点（surface 且带 surfaceOp 时加入）
    // R70-13（十八轮）：可见性谓词与投影对齐——空 usage 壳/损坏载荷的 assistant
    // message 在投影侧（foldSurface/assistantMessageVisible）不算可见，校验器此前
    // 无差别计入，遮蔽契约闸比设计口径宽。R62-11 注释宣称两侧「共用同口径」，今对齐。
    if (isSurfaceType && ev.surfaceOp !== undefined) {
      // R70-13：assistant/message 事件与投影侧 foldSurface 同谓词（user 文本恒可见、
      // assistant 须载荷形别合法且非空壳）
      if (ev.type === 'assistant/message') {
        if (assistantMessageVisible(ev.data)) visibleSeqs.add(ev.seq)
      } else {
        visibleSeqs.add(ev.seq)
      }
    }
  }

  return issues
}
