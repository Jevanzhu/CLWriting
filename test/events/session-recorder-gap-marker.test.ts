/**
 * 0918四轮修复批（B406）回归：SessionRecorder pending 溢出丢弃补 chat_gap 断链标记。
 *
 * 原缺陷形态：落库持续失败（SQLITE_BUSY 耗尽/磁盘满）+ 长对话下 pending 超 256 上限
 * 丢最旧，仅 log.warn 留痕——被丢事件永久丢失后事件流无声不连续，库里没有任何断链
 * 凭据（压缩遮蔽/血缘回放跨缺口时无据可查，「丢事件必留痕」纪律只落在日志层）。
 *
 * 修复：丢弃时在保留段批首垫一条 chat_gap 标记事件（data.dropped = 本次丢弃条数），
 * 随恢复后的下一次成功 flush 一并落库。非 surface、无 surfaceOp——foldSurface 对未知
 * 类型直落忽略、validateEventStream 无专项校验、前端对话种子化只消费投影消息，全链
 * 安全忽略（对齐边界类/meta 类先例）。
 *
 * 钉住面：①溢出后库中恰一条 gap 且 dropped 数正确、标记 seq 先于全部保留事件；
 * ②血缘引用（sourceIdxs）平移不错链——指向已蒸发前驱的引用被剔除、幸存引用 +1 平移
 * 后解析到正确前驱 seq（绝不链到 gap 标记上）；③非溢出失败（<256）不垫标记；
 * ④投影/校验链/历史恢复对 gap 事件安全忽略。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, type SessionStore, type NewEvent } from '../../src/events/store.js'
import {
  SessionRecorder,
  sessionStartEvent,
  userMessageEvent,
  turnStartEvent,
  loadHistoryWithSeqs,
} from '../../src/events/chat-bridge.js'
import { foldSurface, validateEventStream } from '../../src/events/projection.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []
function openTmp(): { store: SessionStore; ud: string } {
  const d = mkdtempTracked(join(tmpdir(), 'b406-gap-'))
  dirs.push(d)
  return { store: openSessionStore(d, '/books/gap')!, ud: d }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** 给真实 store 套「前 failRounds.n 次 appendEventsResolveLineage 必失败」的故障壳 */
function withPersistentFailure(store: SessionStore, failRounds: { n: number }): void {
  const real = store.appendEventsResolveLineage.bind(store)
  store.appendEventsResolveLineage = (sid: string, evs: NewEvent[]) => {
    if (failRounds.n > 0) {
      failRounds.n--
      throw new Error('模拟 SQLITE_BUSY')
    }
    return real(sid, evs)
  }
}

describe('0918四轮修复批 B406: pending 溢出丢弃补 chat_gap 断链标记', () => {
  it('溢出丢弃 → 恢复后库中恰一条 chat_gap、dropped 数正确、seq 先于全部保留事件；投影/校验链/历史恢复安全忽略', () => {
    const warn = vi.spyOn(log, 'warn').mockReturnValue()
    const { store } = openTmp()
    const sid = store.createSession('书G')
    const fail = { n: 1 }
    withPersistentFailure(store, fail)
    const rec = new SessionRecorder(store, sid)
    rec.add(sessionStartEvent('书G'))
    for (let i = 0; i < 300; i++) rec.add(userMessageEvent(`u${i}`))
    // 301 条 > 256：失败 flush 丢最旧 45（session/start + u0–u43），垫 gap 标记
    expect(() => rec.flush()).toThrow('模拟 SQLITE_BUSY')
    expect(
      warn.mock.calls.map((c) => String(c[1])).some((m) => m.includes('丢弃最旧 45') && m.includes('chat_gap')),
    ).toBe(true) // 丢事件必留痕：日志与流内标记双留痕
    const inner = rec as unknown as { pending: NewEvent[] }
    expect(inner.pending[0]).toMatchObject({ type: 'chat_gap', data: { dropped: 45 } }) // 标记垫在保留段批首
    expect(inner.pending).toHaveLength(257) // 标记 1 + 保留真实事件 256（封顶口径不变）
    expect(inner.pending.at(-1)!.data['message']).toBe('u299')
    // 恢复：整批一次落库，gap 标记随批入流
    fail.n = 0
    const range = rec.flush()!
    expect(range.seqs).toHaveLength(257) // 256 真实 + gap 标记
    rec.dispose()

    const evs = store.listEvents('书G')
    const gaps = evs.filter((e) => e.type === 'chat_gap')
    expect(gaps).toHaveLength(1) // 库中恰一条断链标记
    expect(gaps[0]!.data['dropped']).toBe(45)
    expect(gaps[0]!.seq).toBe(range.first)
    expect(evs.some((e) => e.data['message'] === 'u43')).toBe(false) // 被丢事件确实不在库
    expect(evs.some((e) => e.data['message'] === 'u44')).toBe(true) // 保留段首个真实事件
    // 断链凭据在流内可见：标记 seq < 全部保留事件 seq
    const keptSeqs = evs.filter((e) => e.type !== 'chat_gap').map((e) => e.seq)
    expect(keptSeqs.every((s) => s > gaps[0]!.seq)).toBe(true)

    // 折影/校验链/前端种子化全链安全忽略（不炸、不产节点、零 issue）
    expect(foldSurface(evs)).toHaveLength(256) // 只剩保留的 user 消息节点
    expect(validateEventStream(evs)).toEqual([])
    expect(loadHistoryWithSeqs(evs).msgs).toHaveLength(256)
    rec.dispose()
    store.close()
  })

  it('血缘引用平移不错链：指向已蒸发前驱的引用被剔除，幸存引用 +1 后解析到正确前驱（绝不链到 gap 标记）', () => {
    const { store } = openTmp()
    const sid = store.createSession('书G2')
    const fail = { n: 1 }
    withPersistentFailure(store, fail)
    const rec = new SessionRecorder(store, sid)
    for (let i = 0; i < 260; i++) rec.add(turnStartEvent(i)) // 批内 idx 0..259
    rec.add({ type: 'settings/snapshot', data: { scope: 'settings', digest: 'd' } }) // idx 260
    rec.add(userMessageEvent('u')) // idx 261
    rec.add({ type: 'turn/end', turn: 5, data: { reason: 'completed' }, sourceIdxs: [5, 260] }) // idx 262：一 Alive 一 蒸发
    rec.add(userMessageEvent('u2')) // idx 263
    // 264 条 > 256：失败 flush 丢最旧 8（idx 0..7）→ turn/end 平移为批内 255，血缘
    // [5, 260] → 5 指向已蒸发前驱被剔除、260 → 252 → +1 = 253（snapshot 新批位）
    expect(() => rec.flush()).toThrow('模拟 SQLITE_BUSY')
    const inner = rec as unknown as { pending: NewEvent[] }
    expect(inner.pending[0]).toMatchObject({ type: 'chat_gap' })
    const endEv = inner.pending.find((e) => e.type === 'turn/end')!
    expect(endEv.sourceIdxs).toEqual([253]) // 蒸发引用剔除、幸存引用 +1 平移
    // 恢复落库：血缘解析到 snapshot 真实 seq（不含 gap 标记 seq、不含被丢事件）
    fail.n = 0
    const range = rec.flush()!
    const evs = store.listEvents('书G2')
    const gapSeq = evs.find((e) => e.type === 'chat_gap')!.seq
    const endRow = evs.find((e) => e.type === 'turn/end')!
    const snapshotSeq = evs.find((e) => e.type === 'settings/snapshot')!.seq
    expect(endRow.sourceSeqs).toEqual([snapshotSeq])
    expect(endRow.sourceSeqs).not.toContain(gapSeq)
    expect(range.seqs).toHaveLength(257) // gap 标记 + 256 真实事件
    rec.dispose()
    store.close()
  })

  it('非溢出失败（<256）不垫标记：pending 全量保留、恢复后库中零 chat_gap', () => {
    const warn = vi.spyOn(log, 'warn').mockReturnValue()
    const { store } = openTmp()
    const sid = store.createSession('书G3')
    const fail = { n: 1 }
    withPersistentFailure(store, fail)
    const rec = new SessionRecorder(store, sid)
    for (let i = 0; i < 64; i++) rec.add(userMessageEvent(`u${i}`))
    expect(() => rec.flush()).toThrow('模拟 SQLITE_BUSY')
    const inner = rec as unknown as { pending: NewEvent[] }
    expect(inner.pending).toHaveLength(64) // 重试语义不变：一批不丢、无标记
    expect(inner.pending.some((e) => e.type === 'chat_gap')).toBe(false)
    fail.n = 0
    rec.flush()
    expect(store.listEvents('书G3').filter((e) => e.type === 'chat_gap')).toHaveLength(0)
    expect(warn.mock.calls.map((c) => String(c[1])).filter((m) => m.includes('丢弃'))).toEqual([])
    rec.dispose()
    store.close()
  })

  // 六轮重评 A101：溢出裁剪后 pending 恒 257，持续失败下下一轮 dropped 恰为 1、被裁的
  // 第 0 项正是上一轮垫入的 chat_gap 标记——旧实现把它当普通事件丢弃，第一轮真实丢弃
  // 条数的流内唯一凭据被无声替换、dropped 系统性低估。钉住合并口径：旧标记计数累加进
  // 新标记、其自身不计被丢条数、真实事件裁剪与保留语义不变。
  it('连续溢出：上一轮 gap 标记不被裁掉，dropped 累计不失实', () => {
    const warn = vi.spyOn(log, 'warn').mockReturnValue()
    const { store } = openTmp()
    const sid = store.createSession('书G4')
    const fail = { n: 2 }
    withPersistentFailure(store, fail)
    const rec = new SessionRecorder(store, sid)
    rec.add(sessionStartEvent('书G4'))
    for (let i = 0; i < 300; i++) rec.add(userMessageEvent(`u${i}`))
    // 第 1 轮失败：301 条 → 丢 45 真实事件（start + u0–u43），垫 gap(45)，pending=257
    expect(() => rec.flush()).toThrow('模拟 SQLITE_BUSY')
    const inner = rec as unknown as { pending: NewEvent[] }
    expect(inner.pending[0]).toMatchObject({ type: 'chat_gap', data: { dropped: 45 } })
    // 第 2 轮失败：257 条 → dropped=1 恰为旧标记——须合并（45 保持）而非替换丢失
    expect(() => rec.flush()).toThrow('模拟 SQLITE_BUSY')
    expect(inner.pending).toHaveLength(257)
    expect(inner.pending[0]).toMatchObject({ type: 'chat_gap', data: { dropped: 45 } })
    expect(inner.pending.at(-1)!.data['message']).toBe('u299') // 保留段未被误裁
    // 第 3 轮：再攒 50 条（307）→ 丢 51（旧标记 + u44–u93 共 50 真实）→ 合计 45+50=95
    for (let i = 0; i < 50; i++) rec.add(userMessageEvent(`v${i}`))
    fail.n = 1
    expect(() => rec.flush()).toThrow('模拟 SQLITE_BUSY')
    expect(inner.pending).toHaveLength(257)
    expect(inner.pending[0]).toMatchObject({ type: 'chat_gap', data: { dropped: 95 } })
    expect(
      warn.mock.calls.map((c) => String(c[1])).some((m) => m.includes('丢弃最旧 50') && m.includes('累计 95')),
    ).toBe(true)
    // 恢复落库：恰一条 gap、计数 95、被丢真实事件不在库、幸存段边界正确
    fail.n = 0
    const range = rec.flush()!
    expect(range.seqs).toHaveLength(257)
    rec.dispose()
    const evs = store.listEvents('书G4')
    const gaps = evs.filter((e) => e.type === 'chat_gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.data['dropped']).toBe(95)
    expect(evs.some((e) => e.data['message'] === 'u43')).toBe(false) // 第 1 轮被丢
    expect(evs.some((e) => e.data['message'] === 'u93')).toBe(false) // 第 3 轮被丢
    expect(evs.some((e) => e.data['message'] === 'u94')).toBe(true) // 第 3 轮幸存首条
    expect(evs.some((e) => e.data['message'] === 'v49')).toBe(true) // 最新段完整保留
    expect(foldSurface(evs)).toHaveLength(256)
    expect(validateEventStream(evs)).toEqual([])
    store.close()
  })
})
