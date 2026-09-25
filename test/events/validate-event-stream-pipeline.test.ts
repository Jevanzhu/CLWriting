/**
 * R0916-7-P3-2（2026-09-25 全项目源码质量与优雅度评审 P3-2）：校验链拆段后的直测。
 *
 * 分层：整链行为（投影语义、脏流容忍、O(visible) 性能）仍由 projection.test.ts 等件
 * 覆盖；本件只补两层新契约——① 各步函数单测（形状 / 序号与因果 / 载荷语义三段各自
 * 可直测）；② **步骤顺序契约**：同一事件触犯多条时问题数组的次序（先报哪条）是对外
 * 行为，逐串钉住（validateEventStream 的调用序列即该契约唯一落点）。
 */
import { describe, expect, it } from 'vitest'
import {
  advanceVisibleStep,
  createValidateCursor,
  endReasonStep,
  goalOperationStep,
  goalSnapshotStep,
  seqStep,
  shadowCoverageStep,
  shadowIntervalStep,
  snapshotPayloadStep,
  sourceSeqsStep,
  surfaceOpStep,
  todoWriteStep,
  validateEventStream,
} from '../../src/events/projection.js'
import type { ValidateCursor } from '../../src/events/projection.js'
import type { ChatEvent } from '../../src/events/types.js'

function ev(seq: number, type: ChatEvent['type'], data: Record<string, unknown>, extra: Partial<ChatEvent> = {}): ChatEvent {
  return { seq, sessionId: 's1', type, data, createdAt: 1, replaceGeneration: 0, ...extra }
}

const msgs = (issues: Array<{ message: string }>): string[] => issues.map((i) => i.message)

describe('R0916-7-P3-2 段一：序号与因果步', () => {
  it('seqStep：首见零问题；重复只报「seq 重复」；非重复乱序报「未严格递增」（update：seenSeqs/lastSeq）', () => {
    const cur = createValidateCursor()
    expect(seqStep(ev(1, 'user/message', {}), cur)).toEqual([])
    expect([...cur.seenSeqs]).toEqual([1])
    expect(cur.lastSeq).toBe(1)
    // 重复 seq：单条「重复」，不再叠「未严格递增」（R26-103 合并口径）
    expect(msgs(seqStep(ev(1, 'user/message', {}), cur))).toEqual(['seq 重复'])
    expect(cur.lastSeq).toBe(1)
    // 非重复但 ≤ lastSeq：人为把游标推高模拟「内部未排序重放」
    const cur2 = createValidateCursor()
    cur2.lastSeq = 5
    expect(msgs(seqStep(ev(3, 'user/message', {}), cur2))).toEqual(['seq 未严格递增（乱序）'])
    expect([...cur2.seenSeqs]).toEqual([3])
  })

  it('shadowCoverageStep：只对进入区间的已可见 seq 报「含未可见」；形状非法时不重复报', () => {
    const cur = createValidateCursor()
    cur.visibleSeqs.add(1)
    cur.visibleSeqs.add(2)
    const carrier = { surfaceOp: 'replace' as const, shadowStart: 1, shadowEnd: 3, sourceSeqs: [1, 2, 3] }
    const issues = shadowCoverageStep(ev(4, 'compaction/end', { reason: 'completed' }, carrier), cur)
    expect(msgs(issues)).toEqual(['遮蔽区间 [1,3] 含未可见 seq（区间 3 个，可见仅 2 个）'])
    // 区间形状非法（缺端点 / start>end）：形状步已报，本步静默（避免同病灶双报）
    expect(shadowCoverageStep(ev(4, 'compaction/end', {}, { surfaceOp: 'replace', shadowStart: 2, shadowEnd: 1 }), cur)).toEqual([])
    expect(shadowCoverageStep(ev(4, 'compaction/end', {}, { surfaceOp: 'replace' }), cur)).toEqual([])
    // 非载体事件直通
    expect(shadowCoverageStep(ev(4, 'user/message', {}, { surfaceOp: 'append' }), cur)).toEqual([])
  })

  it('sourceSeqsStep：重复 / 不小于当前 seq / 未覆盖被遮蔽节点三类各报各的；区间缺失时只报前两类', () => {
    const cur = createValidateCursor()
    cur.visibleSeqs.add(1)
    cur.visibleSeqs.add(2)
    const issues = sourceSeqsStep(
      ev(3, 'compaction/end', {}, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 2, sourceSeqs: [1, 1, 7] }),
      cur,
    )
    expect(msgs(issues)).toEqual([
      'sourceSeqs 有重复: 1',
      'sourceSeqs 含不小于当前 seq 的 7',
      'sourceSeqs 未覆盖被遮蔽节点 2',
    ])
    // 区间端点缺失：仅血缘自身问题（覆盖校验无从谈起）
    expect(
      msgs(sourceSeqsStep(ev(3, 'compaction/end', {}, { surfaceOp: 'replace', sourceSeqs: [3] }), cur)),
    ).toEqual(['sourceSeqs 含不小于当前 seq 的 3'])
    // 合法血缘（覆盖区间内可见节点、全部早于当前 seq、无重复）→ 零问题
    expect(
      sourceSeqsStep(ev(3, 'compaction/end', {}, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 2, sourceSeqs: [1, 2] }), cur),
    ).toEqual([])
  })

  it('advanceVisibleStep：遮蔽区间移除 + 存档节点加入；assistant 空壳不计可见（与投影同谓词）', () => {
    const cur = createValidateCursor()
    cur.visibleSeqs.add(1)
    cur.visibleSeqs.add(2)
    advanceVisibleStep(
      ev(3, 'compaction/end', { message: '存档摘要' }, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 1, sourceSeqs: [1] }),
      cur,
    )
    expect([...cur.visibleSeqs].sort((a, b) => a - b)).toEqual([2, 3]) // 1 被遮蔽移除，3（存档）加入
    // 无存档内容时不占可见位
    const cur2 = createValidateCursor()
    cur2.visibleSeqs.add(1)
    advanceVisibleStep(ev(3, 'compaction/end', {}, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 1, sourceSeqs: [1] }), cur2)
    expect([...cur2.visibleSeqs]).toEqual([])
    // empty usage 壳（空 content 的 assistant）不进可见集——后续遮蔽它不算「已可见」
    const cur3 = createValidateCursor()
    advanceVisibleStep(ev(1, 'assistant/message', { message: '', usage: {} }, { surfaceOp: 'append' }), cur3)
    expect([...cur3.visibleSeqs]).toEqual([])
    advanceVisibleStep(ev(2, 'assistant/message', { message: '正文' }, { surfaceOp: 'append' }), cur3)
    expect([...cur3.visibleSeqs]).toEqual([2])
  })
})

describe('R0916-7-P3-2 段二：形状步', () => {
  it('surfaceOpStep：禁带 / 必带 / 普通 surface 禁 replace / 载体必须 replace 四条各归位', () => {
    expect(msgs(surfaceOpStep(ev(1, 'turn/start', {}, { surfaceOp: 'append' })))).toEqual(['非 surface 事件禁带 surfaceOp'])
    expect(msgs(surfaceOpStep(ev(1, 'user/message', { message: 'x' })))).toEqual(['surface 事件必须带 surfaceOp'])
    expect(msgs(surfaceOpStep(ev(1, 'user/message', { message: 'x' }, { surfaceOp: 'replace' })))).toEqual([
      '普通 surface 事件禁带 surfaceOp=replace（replace 载体仅 compaction/end）',
    ])
    expect(msgs(surfaceOpStep(ev(1, 'compaction/end', { reason: 'completed' })))).toEqual([
      'compaction/end 必须带 surfaceOp=replace',
    ])
    // 合法载具（surface+append / compaction+replace）零问题
    expect(surfaceOpStep(ev(1, 'tool/result', {}, { surfaceOp: 'append' }))).toEqual([])
    expect(surfaceOpStep(ev(1, 'compaction/end', {}, { surfaceOp: 'replace' }))).toEqual([])
  })

  it('goalSnapshotStep / todoWriteStep / snapshotPayloadStep / shadowIntervalStep：形状判定逐条', () => {
    expect(msgs(goalSnapshotStep(ev(1, 'goal/change', { operation: 'add' })))).toEqual(['goal/change 缺 goal 快照'])
    expect(msgs(goalSnapshotStep(ev(1, 'goal/change', { goal: { id: 'g1' } })))).toEqual(['goal/change 快照缺 id/title', 'goal/change 快照非法 state'])
    expect(goalSnapshotStep(ev(1, 'goal/change', { goal: { id: 'g', title: 't', state: 'active' } }))).toEqual([])
    expect(goalSnapshotStep(ev(1, 'turn/start', {}))).toEqual([])

    expect(msgs(todoWriteStep(ev(1, 'todo/write', {})))).toEqual(['todo/write 缺 todos 数组'])
    expect(msgs(todoWriteStep(ev(1, 'todo/write', { todos: [{ text: 'a', state: 'pending' }, { text: 'b', state: 'bogus' }] })))).toEqual([
      'todo/write 含非法条目',
    ])
    expect(todoWriteStep(ev(1, 'todo/write', { todos: [{ text: 'a', state: 'in_progress' }] }))).toEqual([])

    expect(msgs(snapshotPayloadStep(ev(1, 'settings/snapshot', { scope: 'global' })))).toEqual([
      'settings/snapshot 载荷缺 scope/digest 字符串字段',
    ])
    expect(msgs(snapshotPayloadStep(ev(1, 'skills/snapshot', { scope: 'book' })))).toEqual([
      'skills/snapshot 载荷缺 scope/digest 字符串字段',
    ])
    expect(snapshotPayloadStep(ev(1, 'skills/snapshot', { scope: 'book', digest: 'abc' }))).toEqual([])
    expect(snapshotPayloadStep(ev(1, 'user/message', {}))).toEqual([])

    expect(msgs(shadowIntervalStep(ev(1, 'compaction/end', {}, { surfaceOp: 'replace' })))).toEqual([
      'compaction/end 缺 shadowStart/shadowEnd',
    ])
    expect(msgs(shadowIntervalStep(ev(1, 'compaction/end', {}, { surfaceOp: 'replace', shadowStart: 2, shadowEnd: 1 })))).toEqual([
      'shadowStart > shadowEnd',
    ])
    expect(shadowIntervalStep(ev(1, 'compaction/end', {}, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 2 }))).toEqual([])
  })
})

describe('R0916-7-P3-2 段三：载荷语义步', () => {
  it('endReasonStep：三种终止事件的受控词表；非字符串 reason 容忍（不报）', () => {
    expect(msgs(endReasonStep(ev(1, 'turn/end', { reason: 'timeout' })))).toEqual(['turn/end 非法终止原因: timeout'])
    expect(msgs(endReasonStep(ev(1, 'step/end', { reason: 'whatever' })))).toEqual(['step/end 非法终止原因: whatever'])
    expect(msgs(endReasonStep(ev(1, 'session/end', { reason: 'failed' })))).toEqual(['session/end 非法终止原因: failed'])
    expect(endReasonStep(ev(1, 'turn/end', { reason: 'max-turns' }))).toEqual([])
    expect(endReasonStep(ev(1, 'session/end', { reason: 'completed' }))).toEqual([])
    // 容忍面：reason 非字符串 / 非终止事件 → 零问题
    expect(endReasonStep(ev(1, 'turn/end', { reason: 42 }))).toEqual([])
    expect(endReasonStep(ev(1, 'user/message', { reason: 'timeout' }, { surfaceOp: 'append' }))).toEqual([])
  })

  it('goalOperationStep：受控词表判定；非字符串 operation 容忍', () => {
    expect(msgs(goalOperationStep(ev(1, 'goal/change', { operation: 'bogus' })))).toEqual(['goal/change 非法 operation: bogus'])
    expect(goalOperationStep(ev(1, 'goal/change', { operation: 'create' }))).toEqual([])
    expect(goalOperationStep(ev(1, 'goal/change', { operation: 7 }))).toEqual([])
    expect(goalOperationStep(ev(1, 'todo/write', {}))).toEqual([])
  })
})

describe('R0916-7-P3-2 步骤顺序契约（问题报告次序 = 对外行为）', () => {
  it('同一事件触犯「语义 + 形状」两条 → 先 operation 后快照（步骤 ④ 在 ⑤ 之前）', () => {
    const issues = validateEventStream([ev(1, 'goal/change', { operation: 'bogus' })])
    expect(msgs(issues)).toEqual(['goal/change 非法 operation: bogus', 'goal/change 缺 goal 快照'])
  })

  it('同一事件触犯「载体形状 + 载荷语义」→ 先 surfaceOp 后终止原因（步骤 ② 在 ③ 之前）', () => {
    const issues = validateEventStream([ev(1, 'turn/end', { reason: 'timeout' }, { surfaceOp: 'append' })])
    expect(msgs(issues)).toEqual(['非 surface 事件禁带 surfaceOp', 'turn/end 非法终止原因: timeout'])
  })

  it('同一 compaction 触犯「区间形状 + 血缘」→ 区间形状先报，覆盖校验不再重复扫', () => {
    const issues = validateEventStream([
      ev(1, 'compaction/end', {}, { surfaceOp: 'replace', shadowStart: 9, shadowEnd: 1, sourceSeqs: [12, 12] }),
    ])
    expect(msgs(issues)).toEqual([
      'shadowStart > shadowEnd',
      'sourceSeqs 有重复: 12',
      'sourceSeqs 含不小于当前 seq 的 12',
      'sourceSeqs 含不小于当前 seq 的 12',
    ])
  })

  it('跨事件次序：逐事件按「序号 → 形状 → 语义 → 因果」出串，且与既有多告警口径一致', () => {
    const issues = validateEventStream([
      ev(1, 'user/message', { message: 'a' }), // 缺 surfaceOp
      ev(1, 'turn/end', { reason: 'bogus' }, { surfaceOp: 'append' }), // 重复 seq（先报）→ 载体形状 → 非法原因
      ev(2, 'compaction/end', { reason: 'completed' }, { surfaceOp: 'replace', shadowStart: 1, shadowEnd: 1, sourceSeqs: [1] }),
    ])
    expect(msgs(issues)).toEqual([
      'surface 事件必须带 surfaceOp',
      'seq 重复',
      '非 surface 事件禁带 surfaceOp',
      'turn/end 非法终止原因: bogus',
      '遮蔽区间 [1,1] 含未可见 seq（区间 1 个，可见仅 0 个）', // seq 1 无 surfaceOp → 从未进可见集
    ])
  })

  it('游标只在步骤内推进：乱序输入先排序，未严格递增分支不误报（与整链旧口径一致）', () => {
    const disorder = [
      ev(5, 'user/message', { message: 'a' }, { surfaceOp: 'append' }),
      ev(3, 'user/message', { message: 'b' }, { surfaceOp: 'append' }),
    ]
    expect(validateEventStream(disorder)).toEqual([])
  })
})

describe('R0916-7-P3-2 游标初始化', () => {
  it('createValidateCursor：空集合 + lastSeq=-1（seq 0 起的首事件不报乱序）', () => {
    const cur: ValidateCursor = createValidateCursor()
    expect(cur.seenSeqs.size).toBe(0)
    expect(cur.visibleSeqs.size).toBe(0)
    expect(cur.lastSeq).toBe(-1)
    expect(seqStep(ev(0, 'user/message', {}), cur)).toEqual([])
  })
})
