/**
 * F1-P4 分支/消息树（F1 方案 §七 P4，抄 cherry message.ts 邻接表 + 兄弟组约束）。
 *
 * 分支模型（对齐 cherry）：
 * - 每条消息事件（assistant/message、user/message）可带 parentSeq（前驱消息 seq）
 *   与 branchId（同 parent 的「重新生成」兄弟组；缺省 = 普通线性消息）；
 * - branchId 同组 = 同一 parent 下的多次重新生成（siblingsGroupId 语义）；
 * - 默认分支 = 每组最后一次（最新）；
 * - 分支对话可持久（事件 append-only，元数据在 data JSON）、可切换（selectBranch）。
 *
 * 纯函数，不依赖 DB——单测直接喂事件数组。
 */
import type { ChatEvent, EventType } from './types.js'

/** 分支树节点（surface 消息事件；非 surface 事件也保留用于重放） */
export interface BranchNode {
  seq: number
  type: EventType
  /** 前驱消息事件 seq（重新生成/分支用；缺省 = 普通线性） */
  parentSeq?: number
  /** 兄弟组 ID（同 parent 的重新生成组；缺省 = 无分支） */
  branchId?: string
  data: Record<string, unknown>
}

export interface BranchInfo {
  /** 兄弟组 ID */
  branchId: string
  /** 该组含 surface 消息数 */
  messageCount: number
  /** 组根 seq（第一个节点） */
  rootSeq: number
  /** 组末 seq（最新一次生成的节点） */
  lastSeq: number
  /** 是否默认分支（该 parent 下最新一组） */
  isDefault: boolean
  /** 该组父节点 seq（root 的分支锚点；无 → null） */
  parentSeq: number | null
}

export interface BranchTree {
  /** seq → 节点（全部事件，含非 surface） */
  nodes: Map<number, BranchNode>
  /** branchId → 组内节点 seq[]（按 seq 升序） */
  groups: Map<string, number[]>
  /** seq → parentSeq（无 → undefined） */
  parents: Map<number, number | undefined>
}

/** 从事件流重建分支树（纯函数；events 不必有序） */
export function buildBranchTree(events: ChatEvent[]): BranchTree {
  const sorted = sortEvents(events)
  const nodes = new Map<number, BranchNode>()
  const groups = new Map<string, number[]>()
  const parents = new Map<number, number | undefined>()
  for (const ev of sorted) {
    const parentSeq = typeof ev.data['parentSeq'] === 'number' ? (ev.data['parentSeq'] as number) : undefined
    const branchId = typeof ev.data['branchId'] === 'string' ? (ev.data['branchId'] as string) : undefined
    nodes.set(ev.seq, {
      seq: ev.seq,
      type: ev.type,
      ...(parentSeq !== undefined ? { parentSeq } : {}),
      ...(branchId !== undefined ? { branchId } : {}),
      data: ev.data,
    })
    parents.set(ev.seq, parentSeq)
    if (branchId !== undefined) {
      const g = groups.get(branchId) ?? []
      g.push(ev.seq)
      groups.set(branchId, g)
    }
  }
  return { nodes, groups, parents }
}

/**
 * 列分支组（按组末 seq 降序 = 最新在前）。
 * 无分支元数据的事件（普通线性）不产生分支组。
 */
export function listBranches(tree: BranchTree): BranchInfo[] {
  const out: BranchInfo[] = []
  const latestByParent = new Map<number, { branchId: string; lastSeq: number }>()
  for (const [branchId, seqs] of tree.groups) {
    if (seqs.length === 0) continue
    const rootSeq = seqs[0]!
    const lastSeq = seqs[seqs.length - 1]!
    const parentSeq = tree.parents.get(rootSeq)
    out.push({
      branchId,
      messageCount: seqs.length,
      rootSeq,
      lastSeq,
      isDefault: false,
      parentSeq: parentSeq ?? null,
    })
    if (parentSeq !== undefined) {
      const cur = latestByParent.get(parentSeq)
      if (!cur || lastSeq > cur.lastSeq) latestByParent.set(parentSeq, { branchId, lastSeq })
    }
  }
  // R26-102（二十六轮）：isDefault 判定按「有无 parent」分口径，修复无 parentSeq 分支组
  // 恒非默认的字段/行为分裂——原先 parentSeq 走 `?? -1` 兜底查 latestByParent（该键永不
  // 登记），无 parent 组的 isDefault 恒 false；而 defaultBranchId 取「全部组按 lastSeq
  // 降序首组」的排序兜底，会把无 parent 组选为默认——字段说不是、行为却选中。现：有
  // parent 的组维持「该 parent 下最新一组」口径；无 parent 的组对齐 defaultBranchId 的
  // 排序兜底——全局最新一组（同款 lastSeq 降序取首）恰为无 parent 组时标默认。保证
  // listBranches().find(isDefault) 与 defaultBranchId() 恒一致。
  const globalLatest = [...out].sort((a, b) => b.lastSeq - a.lastSeq)[0]
  for (const b of out) {
    if (b.parentSeq !== null) {
      const latest = latestByParent.get(b.parentSeq)
      b.isDefault = latest?.branchId === b.branchId
    } else {
      b.isDefault = globalLatest?.branchId === b.branchId
    }
  }
  return out.sort((a, b) => b.lastSeq - a.lastSeq)
}

/** 默认分支 ID：最新一组（无分支 → null） */
export function defaultBranchId(tree: BranchTree): string | null {
  const branches = listBranches(tree)
  return branches.length > 0 ? branches[0]!.branchId : null
}

/**
 * 选分支：沿指定 branchId（或其父链）重建「该分支可见的事件序列」。
 *
 * 语义（对齐 cherry 分支树导航）：
 * - 无任何分支元数据（普通线性对话）→ 原样返回全量（按 seq 升序）；
 * - 无 branchId → 默认分支（最新一组）；
 * - 有 branchId → 保留该组全部节点 + 其祖先链（跟随 parentSeq 到根）+
 *   组外无分支线性事件（G1：含 root 之后的普通续聊，防刷新丢消息），
 *   只丢弃其他兄弟分支的节点；未遮蔽过滤由调用方（foldSurface/loadHistoryWithSeqs）处理。
 * - 顶替槽（Z-P1-2）：对每个有变体组的 parent P，(P, 首个组根) 之间的无分支消息
 *   是被 regenerate 顶替的原始回复——从所有分支视图剔除（否则默认视图新旧答案
 *   堆叠，且与进程内「截断到 user 再答」的口径分裂）；组根之后的续聊不受影响。
 */
export function selectBranch(events: ChatEvent[], branchId?: string): ChatEvent[] {
  const tree = buildBranchTree(events)
  const target = branchId ?? defaultBranchId(tree)
  // 内存闸（2026-08-24 审计 B2）：排序结果复用（原实现对同一输入 sortEvents 三次，
  // 每次拷贝一份）——seq 已按 SQL ORDER BY 升序到达（常态），sortEvents 零拷贝直返
  const seq = sortEvents(events)
  if (target === null) return seq

  const group = tree.groups.get(target)
  if (!group) return seq

  // 收集该组节点 + 祖先链（parentSeq 递归到根）
  const keep = new Set<number>()
  const queue = [...group]
  while (queue.length > 0) {
    const seqNo = queue.pop()!
    if (keep.has(seqNo)) continue
    keep.add(seqNo)
    const p = tree.parents.get(seqNo)
    if (p !== undefined && !keep.has(p)) queue.push(p)
  }
  // 顶替槽（Q-6 抽共享）：selectBranch 与 selectBranchTo 同口径过滤
  const slots = supersededSlots(tree)
  // 线性兜底：槽外的「无分支」消息（普通对话消息/旧数据缺 parentSeq）都保留——
  // G1：分支后的普通续聊（seq > rootSeq、无 branchId）也在线性时间线上，
  // 只保 root 之前会把续聊丢出视图（刷新即消失），故不再按 seq 截断；
  // 其他变体（带 branchId）仍被组过滤排除，切换语义不受影响。
  for (const ev of seq) {
    if (ev.data['branchId'] !== undefined) continue
    const superseded = slots.some(([p, root]) => ev.seq > p && ev.seq < root)
    if (!superseded) keep.add(ev.seq)
  }
  return seq.filter((e) => keep.has(e.seq))
}

/** 顶替槽（Z-P1-2 + Q-6 共享）：对每个有变体组的 parent P，(P, 首个组根) 半开区间内的
 *  无分支消息是被 regenerate 顶替的原始回复——任何分支视图都须剔除（selectBranch 的
 *  分支视图与 selectBranchTo 的重生成上下文同口径，否则重生成锚定在被否定的旧答案上）。 */
function supersededSlots(tree: BranchTree): Array<[number, number]> {
  const firstRootByParent = new Map<number, number>()
  for (const seqs of tree.groups.values()) {
    const root = seqs[0]!
    const p = tree.parents.get(root)
    if (p === undefined) continue
    const cur = firstRootByParent.get(p)
    if (cur === undefined || root < cur) firstRootByParent.set(p, root)
  }
  return [...firstRootByParent]
}

/**
 * 恢复到指定 seq 的祖先路径（重新生成入口用）：该节点 + parentSeq 链 + 线性兜底。
 * 用于「重新生成 parentSeq 处的回复」时重建截止该 user 的消息序列。
 */
export function selectBranchTo(events: ChatEvent[], targetSeq: number): ChatEvent[] {
  const tree = buildBranchTree(events)
  const keep = new Set<number>()
  let cur: number | undefined = targetSeq
  while (cur !== undefined && !keep.has(cur)) {
    keep.add(cur)
    cur = tree.parents.get(cur)
  }
  // 线性兜底：targetSeq 之前所有「无分支」消息（普通对话消息/旧数据缺 parentSeq）
  // Q-6：同样过顶替槽——被 regenerate 顶替的原答案不得混入重生成上下文（与
  // selectBranch / 进程内「截断到 user 再答」同口径）。
  // B2（2026-08-24）：排序结果复用（原两次 sortEvents 两次拷贝）
  const slots = supersededSlots(tree)
  const seq = sortEvents(events)
  for (const ev of seq) {
    if (ev.seq >= targetSeq) break
    if (ev.data['branchId'] !== undefined) continue
    const superseded = slots.some(([p, root]) => ev.seq > p && ev.seq < root)
    if (!superseded) keep.add(ev.seq)
  }
  return seq.filter((e) => keep.has(e.seq) && e.seq <= targetSeq)
}

/** 按 seq 升序（与 projection.sortEvents 一致）。
 *  B2（2026-08-24 内存闸）：输入已有序（SQL ORDER BY / 上游已排序——投影链常态）时
 *  O(n) 检测后零拷贝直返，乱序输入回退拷贝排序（纯函数语义不变）。返回值调用方
 *  只读（selectBranch/selectBranchTo 均 filter 产新数组，不改原序）。 */
function sortEvents(events: ChatEvent[]): ChatEvent[] {
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

