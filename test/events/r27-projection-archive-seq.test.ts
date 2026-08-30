/**
 * R27-106（二十七轮）回归——foldSurface 存档插入位序按 seq 判定（不依赖数组位序）：
 * 根因：replace 存档的插入锚由单遍扫描「先到先得」决定——数组位序即锚点序。visible 数组
 * 本应 seq 升序，但存档插在中部后（存档 seq 大于其后的保留节点 seq）数组已失序；后续
 * compaction 的 seq>end 节点（数组在前）会先于遮蔽区间内节点被扫描而抢走锚点——新存档
 * 反插到旧存档之前（原位取代被数组位序击穿），正确性只靠「调用方保证乱序不出现」的
 * 无断言生产不变量。
 * 语义：两候选（区间内首个 / 区间后首个）独立收集后按 seq 取舍——区间内节点 seq ≤ end <
 * 区间后节点 seq，区间内锚恒优先（原位取代）；「区间后首个」（P-15 对照）与「追加尾部」
 * （P-15 兜底）两个锁定行为不变。
 * 测法：两段压缩流——第一段存档插入使数组失序，第二段遮蔽区间只盖旧保留节点：修复前
 * 新存档锚被旧存档抢走 → 非遮蔽序 [6,4,5]（新旧存档翻转）；修复后锚在旧保留节点原位 →
 * 非遮蔽序 [4,6,5]（旧存档仍在新存档前，deriveMessages 顺序与内存历史一致）。
 */
import { describe, expect, it } from 'vitest'
import { foldSurface, deriveMessages } from '../../src/events/projection.js'
import type { ChatEvent } from '../../src/events/types.js'

function ev(seq: number, type: ChatEvent['type'], data: Record<string, unknown>, extra: Partial<ChatEvent> = {}): ChatEvent {
  return { seq, sessionId: 's1', type, data, createdAt: 1, replaceGeneration: 0, ...extra }
}

describe('R27-106: foldSurface 存档插入位序按 seq 判定', () => {
  it('两次压缩且第二段只盖旧保留节点：新存档不越过多存档位序（修复前被 seq>end 节点抢锚）', () => {
    // 事件流：前 3 条消息 → 压缩 A 盖 [1,2]（存档插到数组头部，visible 变为
    // [A@4, a3@3]——数组自此失序）→ u5 追加 → 压缩 B 盖 [3,3]（只遮旧保留节点 a3）。
    // 修复前：扫描先遇 A@4（seq 4 > end 3，数组位 0）→ 锚被抢 → B@6 插到 A@4 之前，
    // 非遮蔽序 [6,4,5]——新存档压在旧存档前，与内存历史 [存档A, 存档B, ...toKeep] 相逆。
    const events: ChatEvent[] = [
      ev(1, 'user/message', { message: 'u1' }, { surfaceOp: 'append' }),
      ev(2, 'assistant/message', { message: 'a2' }, { surfaceOp: 'append' }),
      ev(3, 'assistant/message', { message: 'a3' }, { surfaceOp: 'append' }),
      ev(4, 'compaction/end', { reason: 'completed', message: '存档A（早期回合）' }, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 2, sourceSeqs: [1, 2] }),
      ev(5, 'user/message', { message: 'u5' }, { surfaceOp: 'append' }),
      ev(6, 'compaction/end', { reason: 'completed', message: '存档B（第3条）' }, { surfaceOp: 'replace', shadowStart: 3, shadowEnd: 3, sourceSeqs: [3] }),
    ]
    const nodes = foldSurface(events)
    // 非遮蔽节点序：存档A（seq4）仍在存档B（seq6）之前，u5（seq5）在末尾——数组位序
    // 与 seq 序在这里本就不一致（原位取代语义），位序正确性以「锚在区间内节点原位」为准
    expect(nodes.filter((n) => !n.shadowed).map((n) => n.seq)).toEqual([4, 6, 5])
    expect(nodes.filter((n) => n.shadowed).map((n) => n.seq)).toEqual([1, 2, 3])
    // deriveMessages（喂模型的历史）顺序 = 内存历史 [存档A, 存档B, toKeep=u5]
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: '存档A（早期回合）' },
      { role: 'user', content: '存档B（第3条）' },
      { role: 'user', content: 'u5' },
    ])
  })

  it('单段压缩 + 既有锁定行为不回归：区间语义（P-15 对照）与尾部兜底（P-15 兜底）', () => {
    // P-15 对照（锁定）：可见节点晚于区间尾 → 存档插到该节点之前
    const inRange: ChatEvent[] = [
      ev(5, 'user/message', { message: '后来的' }, { surfaceOp: 'append' }),
      ev(6, 'compaction/end', { reason: 'completed', message: '更早回合的存档摘要' }, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 3, sourceSeqs: [1, 2, 3] }),
    ]
    expect(foldSurface(inRange).map((n) => n.seq)).toEqual([6, 5])
    // P-15 兜底（锁定）：全部可见节点早于区间 → 存档追加尾部
    const fallback: ChatEvent[] = [
      ev(2, 'user/message', { message: '更早的可见消息' }, { surfaceOp: 'append' }),
      ev(6, 'compaction/end', { reason: 'completed', message: '后续不可见回合的存档摘要' }, { surfaceOp: 'replace', shadowStart: 4, shadowEnd: 5, sourceSeqs: [4, 5] }),
    ]
    expect(foldSurface(fallback).map((n) => n.seq)).toEqual([2, 6])
  })

  it('带存档的失序数组上「区间含旧存档」的压缩：锚仍在区间内首节点（不被区间后节点抢先）', () => {
    // 失序数组 [A@4, a3@3, u5@5] 上压缩盖 [3,4]（旧存档 A 与 a3 一起被遮蔽，u5 保留）：
    // 锚取区间内首节点 A@4 的原位（数组位 0），存档 B 插到 u5 之前——区间后节点不抢锚
    const events: ChatEvent[] = [
      ev(1, 'user/message', { message: 'u1' }, { surfaceOp: 'append' }),
      ev(2, 'assistant/message', { message: 'a2' }, { surfaceOp: 'append' }),
      ev(3, 'assistant/message', { message: 'a3' }, { surfaceOp: 'append' }),
      ev(4, 'compaction/end', { reason: 'completed', message: '存档A' }, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 2, sourceSeqs: [1, 2] }),
      ev(5, 'user/message', { message: 'u5' }, { surfaceOp: 'append' }),
      ev(6, 'compaction/end', { reason: 'completed', message: '存档B' }, { surfaceOp: 'replace', shadowStart: 3, shadowEnd: 4, sourceSeqs: [3, 4] }),
    ]
    const nodes = foldSurface(events)
    expect(nodes.filter((n) => !n.shadowed).map((n) => n.seq)).toEqual([6, 5])
    // 被遮蔽节点按数组位序保留（人类抄本审计口径）：存档A 原位插入后数组为
    // [B, A‡, u1‡, a2‡, a3‡, u5]——A(seq4) 排在被遮蔽列表首位，非 seq 序
    expect(nodes.filter((n) => n.shadowed).map((n) => n.seq)).toEqual([4, 1, 2, 3])
    expect(deriveMessages(events)).toEqual([
      { role: 'user', content: '存档B' },
      { role: 'user', content: 'u5' },
    ])
  })
})
