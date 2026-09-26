/**
 * surface 投影纯函数（方案 §四，照抄 dsh surface.ts 语义裁剪）。
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
 *  （内存闸）：输入已有序（SQL ORDER BY / 上游已排序——投影链常态）时
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

/** assistant/message 事件是否会投影为可见节点（载荷形别合法 + 非空壳）。
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
      // 携带存档内容（data.message）时在被遮蔽区间原位取代——投影语义与内存
      // 历史 [存档, ...toKeep] 一致（此前存档只在内存，跨重启恢复丢被压上下文）
      // 插入锚按 seq 优先级判定，不再依赖数组位序——visible 数组
      // 本应 seq 升序，但此前存档插在中部后（存档 seq 大于其后的保留节点 seq）数组已
      // 失序：原单遍扫描「先到先得」会让 seq>end 节点（数组在前）抢走锚点，新存档反插
      // 到旧存档之前（原位取代被数组位序击穿，正确性只靠无断言的生产不变量）。两候选
      // 独立收集后按 seq 取舍：区间内节点 seq ≤ end < 区间后节点 seq → 区间内锚恒优先；
      // 区间内无节点回退「区间后首个」（区间语义）、全无候选追加尾部（兜底），
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
export function deriveMessages(
  events: ChatEvent[],
  prefixSeq?: number,
): Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }> {
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
 * 校验链（§四「校验链」，开发期 fail loud）：
 * - 非 surface 事件禁带 surfaceOp；surface 事件必须带 surfaceOp；普通 surface 事件
 *   禁带 replace（载体仅 compaction/end）
 * - replace 的 shadowStart/shadowEnd 必须已可见且 start≤end
 * - sourceSeqs 必须完整覆盖每个被遮蔽节点、全部早于当前 seq、无重复
 * - seq 单调递增无重复
 * 返回问题列表（空 = 通过）。
 *
 * 原单遍巨型校验体按「形状 / 序号与因果 / 载荷语义」三段拆为可直测的
 * 小步函数（见下方各段注）。**步骤顺序 = 问题报告顺序契约**：同一事件同时触犯多条时
 * 先报哪条、多条之间的相对次序都是对外行为（调用方/日志按序消费），三段拆分不得
 * 重排——validateEventStream 的调用序列即该契约的唯一落点，测试逐条钉住。
 */
export interface ValidationIssue {
  seq: number
  message: string
}

/** 校验游标——跨事件读-写状态（序号去重 / 已可见 seq 集 / 上一 seq）。
 *  各步函数只改自己那一份（序号步写 seenSeqs/lastSeq，因果步写 visibleSeqs）。 */
export interface ValidateCursor {
  seenSeqs: Set<number>
  visibleSeqs: Set<number>
  lastSeq: number
}

/** 新游标（直测各步函数的入口；生产唯一消费方是 validateEventStream） */
export function createValidateCursor(): ValidateCursor {
  return { seenSeqs: new Set(), visibleSeqs: new Set(), lastSeq: -1 }
}

// ─── 段一：序号与因果校验 ───────────────────────────────────────────────

/** 序号步：重复 / 未严格递增。：同一坏事件的「未递增 + 重复」双告警
 *  合并为一条——重复 seq 必然也 ≤ 前一 seq，原先两条 issue 叠发（同一病灶两行噪音）；
 *  现重复只报「seq 重复」，非重复的乱序才报「未严格递增」。 */
export function seqStep(ev: ChatEvent, cur: ValidateCursor): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (cur.seenSeqs.has(ev.seq)) {
    issues.push({ seq: ev.seq, message: 'seq 重复' })
  } else {
    if (ev.seq <= cur.lastSeq) issues.push({ seq: ev.seq, message: 'seq 未严格递增（乱序）' })
    cur.seenSeqs.add(ev.seq)
  }
  cur.lastSeq = ev.seq
  return issues
}

/** 遮蔽可见性步（因果）：被遮蔽节点必须已可见。：改对 visibleSeqs 做区间包含
 *  判断 O(visible)（此前逐 seq 扫 [start,end]：脏数据 shadowEnd=1e9 会线性扫十亿次
 *  挂死校验链）；区间形状非法（缺端点/start>end）时本步不产问题——已由形状步报过。 */
export function shadowCoverageStep(ev: ChatEvent, cur: ValidateCursor): ValidationIssue[] {
  if (ev.type !== 'compaction/end') return []
  const { start, end } = { start: ev.shadowStart, end: ev.shadowEnd }
  if (start === undefined || end === undefined || start > end) return []
  const inRange: number[] = []
  for (const s of cur.visibleSeqs) if (s >= start && s <= end) inRange.push(s)
  if (inRange.length === end - start + 1) return []
  return [
    {
      seq: ev.seq,
      message: `遮蔽区间 [${start},${end}] 含未可见 seq（区间 ${end - start + 1} 个，可见仅 ${inRange.length} 个）`,
    },
  ]
}

/** 血缘步（因果）：sourceSeqs 无重复 / 全部早于当前 seq / 完整覆盖区间内被遮蔽节点。 */
export function sourceSeqsStep(ev: ChatEvent, cur: ValidateCursor): ValidationIssue[] {
  if (ev.type !== 'compaction/end') return []
  const issues: ValidationIssue[] = []
  const srcs = ev.sourceSeqs ?? []
  const dup = srcs.filter((x, i) => srcs.indexOf(x) !== i)
  if (dup.length > 0) issues.push({ seq: ev.seq, message: 'sourceSeqs 有重复: ' + dup.join(',') })
  for (const s of srcs) {
    if (s >= ev.seq) issues.push({ seq: ev.seq, message: 'sourceSeqs 含不小于当前 seq 的 ' + s })
  }
  const start = ev.shadowStart
  const end = ev.shadowEnd
  if (start !== undefined && end !== undefined) {
    // 同款 O(visible)：只对区间内实际可见的 seq 报未覆盖（区间内不可见的
    // 已由上一条「含未可见 seq」报过，脏数据下不重复扫十亿区间）
    const srcSet = new Set(srcs)
    for (const s of cur.visibleSeqs) {
      if (s >= start && s <= end && !srcSet.has(s)) {
        issues.push({ seq: ev.seq, message: 'sourceSeqs 未覆盖被遮蔽节点 ' + s })
      }
    }
  }
  return issues
}

/** 可见集推进步（因果，无问题产出）：遮蔽区间移除 + 存档节点加入 + 本事件成为可见节点。
 *  谓词必须与投影侧 foldSurface 同口径（空 usage 壳/损坏载荷的 assistant
 *  message 不算可见；见 assistantMessageVisible）。 */
export function advanceVisibleStep(ev: ChatEvent, cur: ValidateCursor): void {
  if (ev.type === 'compaction/end') {
    const start = ev.shadowStart
    const end = ev.shadowEnd
    // replace 后 visible 更新：移除被遮蔽节点（同款 O(visible)，不逐 seq 扫区间）
    const st = start ?? 0
    const en = end ?? -1
    for (const s of [...cur.visibleSeqs]) {
      if (s >= st && s <= en) cur.visibleSeqs.delete(s)
    }
    // 携带存档的 compaction/end 本身成为可见节点（投影在区间原位插入存档）
    if (typeof ev.data['message'] === 'string' && ev.data['message'].trim() !== '') {
      cur.visibleSeqs.add(ev.seq)
    }
  }
  // 本事件成为可见节点（surface 且带 surfaceOp 时加入）
  // 可见性谓词与投影对齐——空 usage 壳/损坏载荷的 assistant
  // message 在投影侧（foldSurface/assistantMessageVisible）不算可见，校验器此前
  // 无差别计入，遮蔽契约闸比设计口径宽。 注释宣称两侧「共用同口径」，今对齐。
  if (SURFACE_EVENT_TYPES.has(ev.type as EventType) && ev.surfaceOp !== undefined) {
    if (ev.type === 'assistant/message') {
      if (assistantMessageVisible(ev.data)) cur.visibleSeqs.add(ev.seq)
    } else {
      cur.visibleSeqs.add(ev.seq)
    }
  }
}

// ─── 段二：形状校验 ───────────────────────────────────────────────────

/** 载体形状步：surfaceOp 与事件类型的搭配（禁带 / 必带 / 普通 surface 禁 replace /
 *  compaction/end 必须 replace）。：普通 surface 事件禁带 replace
 *  ——replace 载体仅 compaction/end（遮蔽旧节点 + 存档原位插入的语义与 compaction 数据
 *  形状绑定）；生产构造器不产 surface+replace 形态，此前该形态静默过闸成可见节点而
 *  遮蔽闭区间无消费方，投影/审计口径劈裂，校验链补防。 */
export function surfaceOpStep(ev: ChatEvent): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const isSurfaceType = SURFACE_EVENT_TYPES.has(ev.type as EventType)
  // compaction/end 是 replace 载体（遮蔽旧节点），允许且必须带 surfaceOp='replace'
  const isReplaceCarrier = ev.type === 'compaction/end'
  if (!isSurfaceType && !isReplaceCarrier && ev.surfaceOp !== undefined) {
    issues.push({ seq: ev.seq, message: '非 surface 事件禁带 surfaceOp' })
  }
  if (isSurfaceType && ev.surfaceOp === undefined) {
    issues.push({ seq: ev.seq, message: 'surface 事件必须带 surfaceOp' })
  }
  if (isSurfaceType && ev.surfaceOp === 'replace') {
    issues.push({ seq: ev.seq, message: '普通 surface 事件禁带 surfaceOp=replace（replace 载体仅 compaction/end）' })
  }
  if (isReplaceCarrier && ev.surfaceOp !== 'replace') {
    issues.push({ seq: ev.seq, message: 'compaction/end 必须带 surfaceOp=replace' })
  }
  return issues
}

/** goal 快照形状步：——goal/change 的快照存在性与 id/title/state 字段形。 */
export function goalSnapshotStep(ev: ChatEvent): ValidationIssue[] {
  if (ev.type !== 'goal/change') return []
  const issues: ValidationIssue[] = []
  const goal = ev.data['goal']
  if (!goal || typeof goal !== 'object') {
    issues.push({ seq: ev.seq, message: 'goal/change 缺 goal 快照' })
    return issues
  }
  const g = goal as Record<string, unknown>
  if (typeof g['id'] !== 'string' || typeof g['title'] !== 'string') {
    issues.push({ seq: ev.seq, message: 'goal/change 快照缺 id/title' })
  }
  if (g['state'] !== 'active' && g['state'] !== 'paused' && g['state'] !== 'blocked' && g['state'] !== 'complete') {
    issues.push({ seq: ev.seq, message: 'goal/change 快照非法 state' })
  }
  return issues
}

/** todo 整表形状步：——todo/write 的 todos 数组与逐条目 text/state 形。 */
export function todoWriteStep(ev: ChatEvent): ValidationIssue[] {
  if (ev.type !== 'todo/write') return []
  const todos = ev.data['todos']
  if (!Array.isArray(todos)) return [{ seq: ev.seq, message: 'todo/write 缺 todos 数组' }]
  for (const t of todos) {
    const td = t as Record<string, unknown> | null
    if (
      !td ||
      typeof td['text'] !== 'string' ||
      (td['state'] !== 'pending' && td['state'] !== 'in_progress' && td['state'] !== 'completed')
    ) {
      return [{ seq: ev.seq, message: 'todo/write 含非法条目' }]
    }
  }
  return []
}

/** 快照载荷形状步：——settings/snapshot 与 skills/snapshot 同构 {scope, digest}。 */
export function snapshotPayloadStep(ev: ChatEvent): ValidationIssue[] {
  if (ev.type !== 'settings/snapshot' && ev.type !== 'skills/snapshot') return []
  if (typeof ev.data['scope'] !== 'string' || typeof ev.data['digest'] !== 'string') {
    return [{ seq: ev.seq, message: ev.type + ' 载荷缺 scope/digest 字符串字段' }]
  }
  return []
}

/** 遮蔽区间形状步：compaction/end 必须带 shadowStart/shadowEnd 且 start≤end。 */
export function shadowIntervalStep(ev: ChatEvent): ValidationIssue[] {
  if (ev.type !== 'compaction/end') return []
  const { start, end } = { start: ev.shadowStart, end: ev.shadowEnd }
  if (start === undefined || end === undefined) {
    return [{ seq: ev.seq, message: 'compaction/end 缺 shadowStart/shadowEnd' }]
  }
  if (start > end) return [{ seq: ev.seq, message: 'shadowStart > shadowEnd' }]
  return []
}

// ─── 段三：载荷语义校验 ────────────────────────────────────────────────

/** 终止原因步：——turn/end、step/end、session/end 的 reason 必须是受控词表。 */
export function endReasonStep(ev: ChatEvent): ValidationIssue[] {
  const reason = ev.data['reason']
  if (typeof reason !== 'string') return []
  if (ev.type === 'turn/end' && !(TURN_END_REASONS as readonly string[]).includes(reason)) {
    return [{ seq: ev.seq, message: 'turn/end 非法终止原因: ' + reason }]
  }
  if (ev.type === 'step/end' && !(STEP_END_REASONS as readonly string[]).includes(reason)) {
    return [{ seq: ev.seq, message: 'step/end 非法终止原因: ' + reason }]
  }
  if (ev.type === 'session/end' && !(SESSION_END_REASONS as readonly string[]).includes(reason)) {
    return [{ seq: ev.seq, message: 'session/end 非法终止原因: ' + reason }]
  }
  return []
}

/** goal 操作步：——goal/change 的 operation 受控词表（快照字段形归形状段）。 */
export function goalOperationStep(ev: ChatEvent): ValidationIssue[] {
  if (ev.type !== 'goal/change') return []
  const op = ev.data['operation']
  if (typeof op === 'string' && !(GOAL_OPERATIONS as readonly string[]).includes(op)) {
    return [{ seq: ev.seq, message: 'goal/change 非法 operation: ' + op }]
  }
  return []
}

/**
 * 校验入口：按 seq 升序重放事件，逐事件跑步骤链，返回问题列表（空 = 通过）。
 *
 * **步骤顺序即问题报告顺序契约**（顺序见下方调用序列，勿调换）：语义段与形状段在
 * 步骤链里交错（该事件身上原本先报哪条就保持先报哪条），段别只是关注点归类。
 */
export function validateEventStream(events: ChatEvent[]): ValidationIssue[] {
  const cur = createValidateCursor()
  const issues: ValidationIssue[] = []
  for (const ev of sortEvents(events)) {
    // ① 序号 → ② 载体形状 → ③ 终止原因 → ④ goal 操作 → ⑤ goal 快照 → ⑥ todo
    // → ⑦ 快照载荷 → ⑧ 遮蔽区间形状 → ⑨ 遮蔽可见性 → ⑩ sourceSeqs → ⑪ 可见集推进
    issues.push(...seqStep(ev, cur))
    issues.push(...surfaceOpStep(ev))
    issues.push(...endReasonStep(ev))
    issues.push(...goalOperationStep(ev))
    issues.push(...goalSnapshotStep(ev))
    issues.push(...todoWriteStep(ev))
    issues.push(...snapshotPayloadStep(ev))
    issues.push(...shadowIntervalStep(ev))
    issues.push(...shadowCoverageStep(ev, cur))
    issues.push(...sourceSeqsStep(ev, cur))
    advanceVisibleStep(ev, cur)
  }
  return issues
}
