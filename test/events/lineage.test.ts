/**
 * F1-P3 血缘测试：
 * - digest16 / verifyVisibleRecorded / recordedSnapshots（「模型可见 ⟺ 已记录」校验器）
 * - SessionRecorder 批内 sourceSeqs → 全局 seq 转换（assistant 引用 settings/revision）
 * - recordForeshadowChanges（foreshadow/change 变化登记 + 静默降级）
 */
import { describe, expect, it, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, bookHash, type NewEvent } from '../../src/events/store.js'
import { SessionRecorder, sessionStartEvent, userMessageEvent, turnStartEvent } from '../../src/events/chat-bridge.js'
import {
  settingsSnapshotEvent,
  skillsSnapshotEvent,
  revisionRefEvent,
  recordForeshadowChanges,
} from '../../src/events/chain-bridge.js'
import { assistantMessageEvent } from '../../src/events/chat-bridge.js'
import { digest16, verifyVisibleRecorded, recordedSnapshots } from '../../src/events/lineage.js'
import type { ChatEvent } from '../../src/events/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempTracked(join(tmpdir(), 'f1-lineage-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('F1-P3 digest16', () => {
  it('sha256 前 16 位：稳定、长度 16、不同内容不同指纹', () => {
    expect(digest16('abc')).toBe(digest16('abc'))
    expect(digest16('abc')).toHaveLength(16)
    expect(digest16('abc')).not.toBe(digest16('abd'))
  })
})

describe('F1-P3 verifyVisibleRecorded（模型可见 ⟺ 已记录）', () => {
  const snap = (seq: number, scope: string, digest: string) =>
    ({ seq, type: 'settings/snapshot' as const, data: { scope, digest } }) as never

  it('全部注入有记录 → missing 空', () => {
    const evs = [snap(1, 'settings', 'd1'), snap(2, 'chapter', 'd2')]
    const r = verifyVisibleRecorded(
      [
        { scope: 'settings', digest: 'd1' },
        { scope: 'chapter', digest: 'd2' },
      ],
      evs,
    )
    expect(r.missing).toEqual([])
    expect(r.present).toBe(2)
  })

  it('缺失注入被报告（模型可见但无记录）→ fail loud 判据', () => {
    const evs = [snap(1, 'settings', 'd1')]
    const r = verifyVisibleRecorded(
      [
        { scope: 'settings', digest: 'd1' },
        { scope: 'skillsIndex', digest: 'd9' },
      ],
      evs,
    )
    expect(r.missing).toEqual([{ scope: 'skillsIndex', digest: 'd9' }])
    expect(r.present).toBe(1)
  })

  it('recordedSnapshots 提取 scope/digest/seq', () => {
    const evs = [snap(5, 'settings', 'd1'), snap(9, 'chapter', 'd2')]
    expect(recordedSnapshots(evs)).toEqual([
      { scope: 'settings', digest: 'd1', seq: 5 },
      { scope: 'chapter', digest: 'd2', seq: 9 },
    ])
  })
})

describe('G2-1 verifyVisibleRecorded 三种登记形状（settings/snapshot + revision/ref + skills/snapshot）', () => {
  /** 事件数组 → 带 seq 的 ChatEvent[]（模拟落库后的 seq 分配；模式照抄 branch-tree.test.ts） */
  function seqEvents(evs: NewEvent[]): ChatEvent[] {
    return evs.map((ev, i) => ({
      ...ev,
      seq: i + 1,
      sessionId: 's',
      replaceGeneration: 1,
      createdAt: Date.now(),
      data: { ...ev.data },
    }))
  }

  it('chapter scope：revision/ref{revision} 满足 {scope:"chapter"} 注入；revision 不匹配 → missing', () => {
    const evs = seqEvents([revisionRefEvent({ chapter: 1, revision: 'rev-1', path: '写作/正文/1.md' })])
    expect(verifyVisibleRecorded([{ scope: 'chapter', digest: 'rev-1' }], evs)).toEqual({
      present: 1,
      missing: [],
    })
    // 指纹漂移：记录存在但 revision 与可见注入不一致 → 仍报缺失（scope 对得上也无效）
    expect(verifyVisibleRecorded([{ scope: 'chapter', digest: 'rev-drift' }], evs)).toEqual({
      present: 0,
      missing: [{ scope: 'chapter', digest: 'rev-drift' }],
    })
  })

  it('skills scope：skills/snapshot{digest} 满足 {scope:"skills"} 注入；digest 不匹配 → missing', () => {
    const evs = seqEvents([skillsSnapshotEvent({ digest: 'sk-1' })])
    expect(verifyVisibleRecorded([{ scope: 'skills', digest: 'sk-1' }], evs)).toEqual({
      present: 1,
      missing: [],
    })
    expect(verifyVisibleRecorded([{ scope: 'skills', digest: 'sk-2' }], evs)).toEqual({
      present: 0,
      missing: [{ scope: 'skills', digest: 'sk-2' }],
    })
  })

  it('混合：settings+chapter+skills 同校互不干扰；删任一登记仍精确报缺失（有牙不回退）', () => {
    const all = [
      settingsSnapshotEvent({ scope: 'settings', digest: 'd-set' }),
      revisionRefEvent({ chapter: 1, revision: 'd-ch', path: '写作/正文/1.md' }),
      skillsSnapshotEvent({ digest: 'd-sk' }),
    ]
    const visible = [
      { scope: 'settings', digest: 'd-set' },
      { scope: 'chapter', digest: 'd-ch' },
      { scope: 'skills', digest: 'd-sk' },
    ]
    expect(verifyVisibleRecorded(visible, seqEvents(all))).toEqual({ present: 3, missing: [] })

    // 跨形状不串位：settings/skills 记录满足不了 chapter 注入（scope 不同）
    const noRev = seqEvents([all[0]!, all[2]!])
    expect(verifyVisibleRecorded(visible, noRev).missing).toEqual([{ scope: 'chapter', digest: 'd-ch' }])

    // 负向·删记录：逐一剔除任一登记，对应注入精确报缺失（其余仍 present）
    for (let i = 0; i < all.length; i++) {
      const sabotaged = seqEvents(all.filter((_, j) => j !== i))
      const r = verifyVisibleRecorded(visible, sabotaged)
      expect(r.missing).toEqual([visible[i]!])
      expect(r.present).toBe(2)
    }
  })

  it('recordedSnapshots 三形状归一化提取（revision/ref → scope="chapter"、digest=revision）', () => {
    const evs = seqEvents([
      settingsSnapshotEvent({ scope: 'settings', digest: 'd-set' }),
      revisionRefEvent({ chapter: 1, revision: 'd-ch', path: '写作/正文/1.md' }),
      skillsSnapshotEvent({ digest: 'd-sk' }),
    ])
    expect(recordedSnapshots(evs)).toEqual([
      { scope: 'settings', digest: 'd-set', seq: 1 },
      { scope: 'chapter', digest: 'd-ch', seq: 2 },
      { scope: 'skills', digest: 'd-sk', seq: 3 },
    ])
  })
})

describe('F1-P3 SessionRecorder 批内 sourceIdxs → 全局 sourceSeqs（R26-20 字段拆分）', () => {
  it('assistant 引用同批 settings/revision：flush 后转全局 seq 且 < assistant seq', () => {
    const ud = tmpRoot()
    const bookRoot = '/books/x'
    const store = openSessionStore(ud, bookRoot)!
    try {
      const sessionId = store.createSession('x', { book: 'x' })
      const rec = new SessionRecorder(store, sessionId)
      rec.add(sessionStartEvent('x')) // 批内 0
      rec.add(userMessageEvent('hi')) // 批内 1
      rec.add(turnStartEvent(0)) // 批内 2
      const settingsIdx = rec.add(settingsSnapshotEvent({ scope: 'settings', digest: 'd1' })) // 3
      const revisionIdx = rec.add(revisionRefEvent({ chapter: 1, revision: 'r1', path: '写作/正文/1.md' })) // 4
      rec.add(assistantMessageEvent('ok', undefined, undefined, [settingsIdx, revisionIdx])) // 5
      const range = rec.flush()!
      expect(range.first).toBe(1)

      const evs = store.listEvents('x')
      const asst = evs.find((e) => e.type === 'assistant/message')!
      expect(asst.sourceSeqs).toEqual([1 + 3, 1 + 4]) // 全局 seq（批内 + first）
      expect(asst.sourceSeqs!.every((s) => s < asst.seq)).toBe(true) // 投影约束：早于当前 seq
      const snap = evs.find((e) => e.type === 'settings/snapshot')!
      expect(snap.data).toMatchObject({ scope: 'settings', digest: 'd1' })
      const rev = evs.find((e) => e.type === 'revision/ref')!
      expect(rev.data).toMatchObject({ chapter: 1, revision: 'r1' })
      // 完整来源链可回溯：assistant.sourceSeqs 均能在事件流定位
      for (const s of asst.sourceSeqs!) {
        expect(evs.some((e) => e.seq === s)).toBe(true)
      }
    } finally {
      store.close()
    }
  })

  it('AA-P3-7: sourceSeqs 用 INSERT RETURNING 真实 seq——非零基线（前序事件）下批内索引仍正确映射', () => {
    const ud = tmpRoot()
    const bookRoot = '/books/l'
    const store = openSessionStore(ud, bookRoot)!
    try {
      const sessionId = store.createSession('l', { book: 'l' })
      // 基线：直接落 3 条前序事件（seq 1..3），把 lastSeq 推到 3——旧实现用
      // lastSeq()+批内序号推算，与「真实分配 seq」在并发写窗口下可能错链
      store.appendEvents(sessionId, [
        { type: 'user/message', data: { text: '基线1' } },
        { type: 'user/message', data: { text: '基线2' } },
        { type: 'user/message', data: { text: '基线3' } },
      ])

      const rec = new SessionRecorder(store, sessionId)
      rec.add(sessionStartEvent('l')) // 批内 0 → 真实 seq 4
      const settingsIdx = rec.add(settingsSnapshotEvent({ scope: 'settings', digest: 'd2' })) // 批内 1 → 5
      const revisionIdx = rec.add(revisionRefEvent({ chapter: 2, revision: 'r2', path: '写作/正文/2.md' })) // 批内 2 → 6
      rec.add(assistantMessageEvent('ok', undefined, undefined, [settingsIdx, revisionIdx])) // 批内 3 → 7
      const range = rec.flush()!
      expect(range).toEqual({ first: 4, last: 7, seqs: [4, 5, 6, 7] }) // R65-23：flush 透出批内真实 seq

      const evs = store.listEvents('l')
      const asst = evs.find((e) => e.type === 'assistant/message')!
      // 真实 seq：批内 1→5、批内 2→6（= 数据库实际分配的 seq，而非 lastSeq 推算）
      expect(asst.sourceSeqs).toEqual([5, 6])
      expect(asst.sourceSeqs!.every((s) => s < asst.seq)).toBe(true)
      // 血缘可回溯：5/6 都能在事件流定位到 settings/snapshot 与 revision/ref
      expect(evs.find((e) => e.seq === 5)!.type).toBe('settings/snapshot')
      expect(evs.find((e) => e.seq === 6)!.type).toBe('revision/ref')
    } finally {
      store.close()
    }
  })

  // hh §八-18：批内血缘索引越界无防御的回归——seqs[s]! 断言曾把 undefined 写成 null 血缘
  // R26-20：字段改名 sourceIdxs（与全局 seq 语义的 sourceSeqs 拆分），越界防御口径不变
  it('越界/负数/非整数索引：抛错回滚整批零残留；合法批随后照常', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/y')!
    try {
      const sessionId = store.createSession('y', { book: 'y' })
      const mk = (sourceIdxs?: number[]): NewEvent[] => [
        sessionStartEvent('y'),
        assistantMessageEvent('hi', undefined, undefined, sourceIdxs),
      ]
      for (const bad of [[2], [-1], [0.5], [Number.NaN], [0, 99]]) {
        expect(() => store.appendEventsResolveLineage(sessionId, mk(bad))).toThrow(/血缘引用越界/)
      }
      // 事务回滚：非法批一行不落（listEvents 首参是 book，会话限定走双参）
      expect(store.listEvents('y', sessionId)).toHaveLength(0)
      // 合法批照常：批内 [0] → 全局首个 seq，回写可读回
      const seqs = store.appendEventsResolveLineage(sessionId, mk([0]))
      expect(seqs).toHaveLength(2)
      const asst = store.listEvents('y', sessionId).find((e) => e.type === 'assistant/message')!
      expect(asst.sourceSeqs).toEqual([seqs[0]])
    } finally {
      store.close()
    }
  })

  // R26-20（二十六轮）：sourceIdxs / sourceSeqs 按方法拆分——NewEvent 直带 sourceIdxs
  // 走批内索引解析（seq 回写正确）；带 sourceSeqs（全局 seq 语义，appendEvents 专用）
  // 一律拒收报错，双语义陷阱闭合
  it('R26-20: NewEvent 直带 sourceIdxs → 按批内索引回写全局 seq；带 sourceSeqs → 拒收报错', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/z')!
    try {
      const sessionId = store.createSession('z', { book: 'z' })
      // sourceIdxs 建血缘：批内 [0, 1] → 本批真实 seq（INSERT RETURNING），落 source_seqs 列
      const seqs = store.appendEventsResolveLineage(sessionId, [
        { type: 'session/start', data: { book: 'z' } },
        { type: 'user/message', data: { message: 'q' }, surfaceOp: 'append' },
        { type: 'assistant/message', data: { message: 'a' }, surfaceOp: 'append', sourceIdxs: [0, 1] },
      ])
      const asst = store.listEvents('z', sessionId).find((e) => e.type === 'assistant/message')!
      expect(asst.sourceSeqs).toEqual([seqs[0], seqs[1]])
      expect(asst.sourceSeqs!.every((s) => s < asst.seq)).toBe(true)

      // 拒收 sourceSeqs：本方法按批内索引解析，全局 seq 传进来会被错链——宁可红不可错
      const bad: NewEvent[] = [
        { type: 'session/start', data: { book: 'z' } },
        { type: 'assistant/message', data: { message: 'x' }, surfaceOp: 'append', sourceSeqs: [1, 2] },
      ]
      expect(() => store.appendEventsResolveLineage(sessionId, bad)).toThrow(/sourceSeqs.*sourceIdxs|双语义/)
      // 抛错回滚整批零残留
      expect(store.listEvents('z', sessionId)).toHaveLength(3)
    } finally {
      store.close()
    }
  })
})

describe('F1-P3 recordForeshadowChanges', () => {
  it('create/edit/complete/block/clear 变化登记', () => {
    const ud = tmpRoot()
    const bookRoot = '/books/f'
    const store = openSessionStore(ud, bookRoot)!
    try {
      const sessionId = store.workspaceSession(bookHash(bookRoot))
      recordForeshadowChanges(
        store,
        sessionId,
        [
          { 标题: '古剑', 状态: '未回收' },
          { 标题: '旧物', 状态: '已回收' },
        ],
        [
          { 标题: '古剑', 状态: '已回收' },
          { 标题: '新伏笔', 状态: '未回收' },
        ],
      )
      const evs = store.listEvents(bookHash(bookRoot))
      const types = evs.map((e) => e.data as { operation: string; title: string })
      expect(types).toContainEqual({ operation: 'complete', title: '古剑' })
      expect(types).toContainEqual({ operation: 'create', title: '新伏笔' })
      expect(types).toContainEqual({ operation: 'clear', title: '旧物' })
    } finally {
      store.close()
    }
  })

  it('无变化 → 不写事件；store 缺失 → 静默跳过', () => {
    const ud = tmpRoot()
    const bookRoot = '/books/f2'
    const store = openSessionStore(ud, bookRoot)!
    try {
      const sessionId = store.workspaceSession(bookHash(bookRoot))
      recordForeshadowChanges(
        store,
        sessionId,
        [{ 标题: 'A', 状态: '未回收' }],
        [{ 标题: 'A', 状态: '未回收' }],
      )
      expect(store.listEvents(bookHash(bookRoot))).toHaveLength(0)
      expect(() => recordForeshadowChanges(null, null, [], [])).not.toThrow()
    } finally {
      store.close()
    }
  })
})

