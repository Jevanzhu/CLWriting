/**
 * F1-P4 分支/消息树单测：邻接表（parentSeq）+ 兄弟组（branchId）重建、
 * 列分支/默认分支、选分支重建（可切换）、普通线性不产生分支。
 */
import { describe, expect, it } from 'vitest'
import {
  buildBranchTree,
  listBranches,
  defaultBranchId,
  selectBranch,
  selectBranchTo,
} from '../../src/events/branch-tree.js'
import { assistantMessageEvent, userMessageEvent, toolResultEvent } from '../../src/events/chat-bridge.js'
import type { ChatEvent } from '../../src/events/types.js'

/** 事件数组 → 带 seq 的 ChatEvent[]（模拟落库后的 seq 分配） */
function seqEvents(evs: ReturnType<typeof userMessageEvent>[]): ChatEvent[] {
  return evs.map((ev, i) => ({
    ...ev,
    seq: i + 1,
    sessionId: 's',
    replaceGeneration: 1,
    createdAt: Date.now(),
    data: { ...ev.data },
  }))
}

describe('F1-P4 buildBranchTree', () => {
  it('无分支元数据 → 无分组、无父链（普通线性）', () => {
    const evs = seqEvents([userMessageEvent('hi'), assistantMessageEvent('ok')])
    const tree = buildBranchTree(evs)
    expect(tree.groups.size).toBe(0)
    expect(tree.parents.get(1)).toBeUndefined()
    expect(listBranches(tree)).toEqual([])
    expect(defaultBranchId(tree)).toBeNull()
  })

  it('重新生成：同 parentSeq 不同 branchId → 两组，最新组为默认', () => {
    const evs = seqEvents([
      userMessageEvent('hi'), // seq1
      assistantMessageEvent('v1', undefined, undefined, undefined, { parentSeq: 1, branchId: 'b1' }), // seq2
      assistantMessageEvent('v2', undefined, undefined, undefined, { parentSeq: 1, branchId: 'b1' }), // seq3 同组第二次
      assistantMessageEvent('v3', undefined, undefined, undefined, { parentSeq: 1, branchId: 'b2' }), // seq4 新组
    ])
    const tree = buildBranchTree(evs)
    const branches = listBranches(tree)
    expect(branches).toHaveLength(2)
    const b1 = branches.find((b) => b.branchId === 'b1')!
    const b2 = branches.find((b) => b.branchId === 'b2')!
    expect(b1.messageCount).toBe(2)
    expect(b1.parentSeq).toBe(1)
    expect(b1.lastSeq).toBe(3)
    expect(b2.messageCount).toBe(1)
    expect(b2.lastSeq).toBe(4)
    expect(b2.isDefault).toBe(true) // 最新组默认
    expect(b1.isDefault).toBe(false)
    expect(defaultBranchId(tree)).toBe('b2')
  })
})

describe('F1-P4 selectBranch（分支可切换）', () => {
  it('默认分支 → 最新组 + 祖先链；切换回旧组 → 旧组 + 祖先链', () => {
    const evs = seqEvents([
      userMessageEvent('hi'), // 1
      assistantMessageEvent('v1', undefined, undefined, undefined, { parentSeq: 1, branchId: 'b1' }), // 2
      assistantMessageEvent('v2', undefined, undefined, undefined, { parentSeq: 1, branchId: 'b2' }), // 3
    ])
    // 默认 = b2（最新）
    const def = selectBranch(evs)
    expect(def.map((e) => e.seq)).toEqual([1, 3]) // user + b2
    // 切到 b1
    const old = selectBranch(evs, 'b1')
    expect(old.map((e) => e.seq)).toEqual([1, 2])
  })

  it('深层分支：保留整条祖先链（父分支的父分支）', () => {
    const evs = seqEvents([
      userMessageEvent('q'), // 1
      assistantMessageEvent('a1'), // 2 普通 assistant（无分支元数据）
      userMessageEvent('follow'), // 3
      assistantMessageEvent('a2', undefined, undefined, undefined, { parentSeq: 3, branchId: 'g2' }), // 4 重新生成（跨批全局引用）
      assistantMessageEvent('a3', undefined, undefined, undefined, { parentSeq: 3, branchId: 'g3' }), // 5 另一组重新生成
    ])
    const sel = selectBranch(evs, 'g2')
    // g2 路径 = user(q) + a1(g1) + user(follow) + a2(g2)
    expect(sel.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('无分支元数据 → 全量原样返回（普通线性不受影响）', () => {
    const evs = seqEvents([userMessageEvent('hi'), assistantMessageEvent('ok')])
    const sel = selectBranch(evs)
    expect(sel.map((e) => e.seq)).toEqual([1, 2])
    expect(selectBranch(evs, 'nope')).toHaveLength(2) // 未知 branchId → 全量
  })

  it('tool 事件（非分支元数据）保留在祖先链内', () => {
    const evs = seqEvents([
      userMessageEvent('q'), // 1
      assistantMessageEvent('tool-reply'), // 2 普通 tool 回复
      toolResultEvent('c1', '结果'), // 3
      assistantMessageEvent('final', undefined, undefined, undefined, { parentSeq: 3, branchId: 'g2' }), // 4 重新生成
    ])
    const sel = selectBranch(evs, 'g2')
    expect(sel.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('G1：分支后的普通续聊（无 branchId、seq > rootSeq）不丢出分支视图', () => {
    const evs = seqEvents([
      userMessageEvent('q'), // 1
      assistantMessageEvent('a0'), // 2 初版线性回复
      assistantMessageEvent('a1', undefined, undefined, undefined, { parentSeq: 1, branchId: 'b1' }), // 3 变体一
      userMessageEvent('follow'), // 4 分支后普通续聊（线性）
      assistantMessageEvent('a2'), // 5
      assistantMessageEvent('a1p', undefined, undefined, undefined, { parentSeq: 1, branchId: 'b2' }), // 6 变体二
    ])
    // 默认（最新组 b2）：续聊（4/5）保留 + b2；a0（2）在顶替槽 (1,3) 内——被 regenerate
    // 顶替的原始回复，从视图剔除（否则默认视图新旧答案堆叠、与进程内截断口径分裂）；
    // b1 变体被组过滤排除
    expect(selectBranch(evs).map((e) => e.seq)).toEqual([1, 4, 5, 6])
    // 切到旧组 b1：b2 被排除，续聊（4/5）仍在——刷新/切分支都不丢消息；a0 同理剔除
    expect(selectBranch(evs, 'b1').map((e) => e.seq)).toEqual([1, 3, 4, 5])
  })
})

describe('F1-P4 selectBranchTo（重新生成入口：恢复到指定 seq）', () => {
  it('恢复到触发 user：parentSeq 链 + 之前的普通消息', () => {
    const evs = seqEvents([
      userMessageEvent('q'), // 1
      assistantMessageEvent('a1'), // 2
      userMessageEvent('follow'), // 3
      assistantMessageEvent('a2', undefined, undefined, undefined, { parentSeq: 3, branchId: 'g2' }), // 4
      userMessageEvent('more', undefined, { parentSeq: 4 }), // 5 分支上继续：parentSeq 指向分支 assistant
    ])
    // 重新生成 more(5) 的回复 → 恢复到 5
    const sel = selectBranchTo(evs, 5)
    expect(sel.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
    // 重新生成 follow(3) 的回复 → 恢复到 3（不含 a2/more）
    const sel2 = selectBranchTo(evs, 3)
    expect(sel2.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('平行分支：恢复到目标 seq 不引入其他分支组节点', () => {
    const evs = seqEvents([
      userMessageEvent('q'), // 1
      assistantMessageEvent('v1', undefined, undefined, undefined, { parentSeq: 1, branchId: 'g1' }), // 2
      assistantMessageEvent('v2', undefined, undefined, undefined, { parentSeq: 1, branchId: 'g2' }), // 3
    ])
    // 重新生成 v1(2) → 恢复到 parentSeq=1（不含 v1/v2 分支组）
    const sel = selectBranchTo(evs, 1)
    expect(sel.map((e) => e.seq)).toEqual([1])
  })

  it('祖先链：parentSeq 递归保留（重新生成深层分支的触发 user）', () => {
    const evs = seqEvents([
      userMessageEvent('q'), // 1
      assistantMessageEvent('a1'), // 2
      userMessageEvent('follow'), // 3
      assistantMessageEvent('a2', undefined, undefined, undefined, { parentSeq: 3, branchId: 'g2' }), // 4
      userMessageEvent('more'), // 5
    ])
    const sel = selectBranchTo(evs, 3)
    // 3 无 parentSeq → 兜底保留 seq<3 无 branchId = 1,2
    expect(sel.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  // Q-6（第十五轮）：顶替槽在 targetSeq 之后时，selectBranchTo 兜底同样过滤被顶替
  // 原答案——U1→A0（后被变体顶替）→b1→U2，对 U2 重生成不得把 A0 喂回模型。
  it('Q-6: 顶替槽后的 targetSeq——被顶替原答案不混入重生成上下文', () => {
    const evs = seqEvents([
      userMessageEvent('q'), // 1
      assistantMessageEvent('旧答案A0', undefined, undefined, undefined, { parentSeq: 1 }), // 2 无 branchId：被顶替的原回复
      assistantMessageEvent('新变体b1', undefined, undefined, undefined, { parentSeq: 1, branchId: 'v1' }), // 3
      userMessageEvent('续聊U2', undefined, { parentSeq: 3 }), // 4 在变体分支上续聊
      assistantMessageEvent('A2', undefined, undefined, undefined, { parentSeq: 4 }), // 5
    ])
    // 修复前：兜底全量保留 branchless（含 A0）→ [1,2,3,4]，重生成锚定在被否定旧答案上
    expect(selectBranchTo(evs, 4).map((e) => e.seq)).toEqual([1, 3, 4])
    // 对照：selectBranch 默认视图同口径（A0 剔除、变体与续聊保留）
    expect(selectBranch(evs).map((e) => e.seq)).toEqual([1, 3, 4, 5])
  })
  // B2（2026-08-24 内存闸）：sortEvents 有序零拷贝直返改造的行为锁——乱序输入回退
  // 排序拷贝，selectBranch/selectBranchTo 对乱序/有序输入产出逐一恒等（上游
  // listEvents 恒按 seq 升序到达，乱序仅测试/历史数据防御路径）
  it('B2: 乱序输入与有序输入的 selectBranch/selectBranchTo 产出恒等', () => {
    const ordered = seqEvents([
      userMessageEvent('q'), // 1
      assistantMessageEvent('旧答案A0', undefined, undefined, undefined, { parentSeq: 1 }), // 2
      assistantMessageEvent('新变体b1', undefined, undefined, undefined, { parentSeq: 1, branchId: 'v1' }), // 3
      userMessageEvent('续聊U2', undefined, { parentSeq: 3 }), // 4
      assistantMessageEvent('A2'), // 5
    ])
    const shuffled = [ordered[2]!, ordered[0]!, ordered[4]!, ordered[1]!, ordered[3]!]
    expect(selectBranch(shuffled).map((e) => e.seq)).toEqual(selectBranch(ordered).map((e) => e.seq))
    expect(selectBranchTo(shuffled, 4).map((e) => e.seq)).toEqual(selectBranchTo(ordered, 4).map((e) => e.seq))
    // 有序输入直返原数组引用（零拷贝），调用方 filter 不改原序
    const linear = seqEvents([userMessageEvent('q'), assistantMessageEvent('a')])
    expect(selectBranch(linear)).toBe(linear)
  })
})

// ── R26-102（二十六轮）：无 parentSeq 分支组的 isDefault 判定 ──
// 修复前：parentSeq 走 `?? -1` 查 latestByParent（该键永不登记）→ 无 parent 组 isDefault
// 恒 false；而 defaultBranchId 按「全部组 lastSeq 降序取首」的排序兜底会选中它——字段与
// 行为分裂。现无 parent 组对齐 defaultBranchId 的排序兜底口径，字段/行为恒一致。
describe('R26-102: 无 parentSeq 分支组的 isDefault（对齐 defaultBranchId 排序兜底）', () => {
  it('只有无 parent 组：全局最新组 isDefault=true，且 find(isDefault) === defaultBranchId', () => {
    const evs = seqEvents([
      assistantMessageEvent('v1', undefined, undefined, undefined, { branchId: 'b1' }), // seq1
      assistantMessageEvent('v2', undefined, undefined, undefined, { branchId: 'b1' }), // seq2 同组
      assistantMessageEvent('v3', undefined, undefined, undefined, { branchId: 'b2' }), // seq3 新组
    ])
    const tree = buildBranchTree(evs)
    const branches = listBranches(tree)
    const b1 = branches.find((b) => b.branchId === 'b1')!
    const b2 = branches.find((b) => b.branchId === 'b2')!
    expect(b1.parentSeq).toBeNull()
    expect(b2.parentSeq).toBeNull()
    expect(b1.isDefault).toBe(false) // 非全局最新
    expect(b2.isDefault).toBe(true) // 修复前恒 false（字段/行为分裂）
    expect(defaultBranchId(tree)).toBe('b2')
    expect(branches.find((b) => b.isDefault)?.branchId).toBe(defaultBranchId(tree))
  })

  it('无 parent 组与有 parent 组混存：全局最新组持有默认位，两口径不打架', () => {
    const evs = seqEvents([
      userMessageEvent('hi'), // seq1
      assistantMessageEvent('root-less', undefined, undefined, undefined, { branchId: 'b1' }), // seq2 无 parent 组
      assistantMessageEvent('v1', undefined, undefined, undefined, { parentSeq: 1, branchId: 'g1' }), // seq3 有 parent 组
    ])
    const tree = buildBranchTree(evs)
    const branches = listBranches(tree)
    expect(defaultBranchId(tree)).toBe('g1') // 排序兜底取全局最新
    const b1 = branches.find((b) => b.branchId === 'b1')!
    const g1 = branches.find((b) => b.branchId === 'g1')!
    expect(b1.isDefault).toBe(false) // 全局最新组是有 parent 的 g1，无 parent 组不抢默认位
    expect(g1.isDefault).toBe(true)
    expect(branches.find((b) => b.isDefault)?.branchId).toBe(defaultBranchId(tree))
  })
})
