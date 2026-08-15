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
})

