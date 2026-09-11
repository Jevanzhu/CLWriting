/**
 * R0912-2（2026-09-11 修复批）回归：SessionRecorder.flush 失败路径 pending 有界。
 *
 * appendEventsResolveLineage 抛错时 pending 保留待重试（R62-10 语义，正确），但落库
 * 持续失败（SQLITE_BUSY 耗尽/磁盘满）+ 长对话下 pending 无界增长。修复：对齐同文件
 * ChainRecorder（chain-bridge.ts O-1/R55-B-4）——超 256 上限 warn 留痕并丢最旧
 * （保最新对话语义）；被丢事件占用的批内序号（pendingSurfaceIdx）与批内血缘引用
 * （sourceIdxs）同步平移，恢复后的 flush 可正常落库、血缘解析不越界不错链。
 *
 * 故障模拟用「真实 store + 前 N 次必失败壳」：恢复轮走真库（批内索引校验「宁可红
 * 不可错」/血缘回写全在），比纯 fake store 更能证明恢复路径可用。
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
  assistantMessageEvent,
  turnStartEvent,
} from '../../src/events/chat-bridge.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []
function openTmp(): { store: SessionStore; ud: string } {
  const d = mkdtempTracked(join(tmpdir(), 'r0912-cap-'))
  dirs.push(d)
  return { store: openSessionStore(d, '/books/a')!, ud: d }
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

describe('R0912-2: SessionRecorder.flush 失败路径 pending 有界', () => {
  it('持续失败 ≥256+ 条：pending 封顶、warn 留丢弃数/回合、最新事件保留；恢复后新事件可落', () => {
    const warn = vi.spyOn(log, 'warn').mockReturnValue()
    const { store } = openTmp()
    const sid = store.createSession('书A')
    const fail = { n: 2 }
    withPersistentFailure(store, fail)
    const rec = new SessionRecorder(store, sid)
    rec.add(sessionStartEvent('书A'))
    for (let i = 0; i < 300; i++) {
      rec.add({ ...userMessageEvent(`u${i}`), turn: Math.floor(i / 10) })
    }
    const inner = rec as unknown as { pending: NewEvent[] }
    expect(inner.pending.length).toBe(301)
    // 第一次 flush 失败：pending 保留待重试（R62-10 语义不变）但封顶 256（丢最旧 45）
    expect(() => rec.flush()).toThrow('模拟 SQLITE_BUSY')
    expect(inner.pending.length).toBe(256)
    const dropWarns = warn.mock.calls
      .map((c) => String(c[1]))
      .filter((m) => m.includes('SessionRecorder') && m.includes('丢弃最旧'))
    expect(dropWarns.length, '超限丢弃必须 warn 留痕').toBe(1)
    expect(dropWarns[0]).toContain('45') // 丢弃条数（301 - 256）
    expect(dropWarns[0]).toContain('turn 0–4') // 涉及回合（u0–u43 → turn 0–4；session/start 无 turn 不计）
    expect(inner.pending.at(-1)!.data['message']).toBe('u299') // 最新事件仍在（保最新对话语义）
    // 继续累积 + 第二次失败：仍封顶（不随失败次数无界增长）
    for (let i = 300; i < 330; i++) {
      rec.add({ ...userMessageEvent(`u${i}`), turn: Math.floor(i / 10) })
    }
    expect(inner.pending.length).toBe(286)
    expect(() => rec.flush()).toThrow('模拟 SQLITE_BUSY')
    expect(inner.pending.length).toBe(256)
    expect(inner.pending.at(-1)!.data['message']).toBe('u329')
    // 恢复：故障解除 → 新事件照常入批，整批一次落库
    fail.n = 0
    rec.add(userMessageEvent('恢复后的新事件'))
    const range = rec.flush()!
    expect(range.seqs).toHaveLength(257)
    expect(rec.allSessionSeqs()).toHaveLength(257) // pendingSurfaceIdx 平移后无错位（surface 全量拿到真实 seq）
    const evs = store.listEvents('书A')
    expect(evs.some((e) => e.data['message'] === 'u0')).toBe(false) // 被丢最旧不落库
    expect(evs.some((e) => e.data['message'] === 'u299')).toBe(true) // 保留的最新事件落库
    expect(evs.some((e) => e.data['message'] === '恢复后的新事件')).toBe(true)
    rec.dispose()
    store.close()
  })

  it('被丢事件占用的批内序号同步平移：恢复后 sourceIdxs 不越界、血缘解析到保留事件真实 seq', () => {
    const { store } = openTmp()
    const sid = store.createSession('书A')
    const fail = { n: 1 }
    withPersistentFailure(store, fail)
    const rec = new SessionRecorder(store, sid)
    for (let i = 0; i < 260; i++) rec.add(turnStartEvent(i)) // 批内 idx 0..259（非表面类）
    rec.add({ type: 'settings/snapshot', data: { scope: 'settings', digest: 'd' } }) // idx 260
    rec.add(userMessageEvent('u')) // idx 261
    rec.add(assistantMessageEvent('a', undefined, undefined, [260, 261])) // idx 262：血缘引用快照+user
    // 263 条 > 256：失败 flush 丢最旧 7 → 快照/user/assistant 平移为批内 253/254/255
    expect(() => rec.flush()).toThrow('模拟 SQLITE_BUSY')
    const inner = rec as unknown as { pending: NewEvent[] }
    expect(inner.pending.length).toBe(256)
    expect(inner.pending.at(-1)!.sourceIdxs).toEqual([253, 254]) // 血缘引用随丢弃平移——原 [260,261] 越界必炸恢复 flush
    // 恢复：真库批内索引校验 + 血缘回写全通过
    fail.n = 0
    const range = rec.flush()!
    const evs = store.listEvents('书A')
    const asstRow = evs.find((e) => e.type === 'assistant/message')!
    expect(asstRow.seq).toBe(range.seqs[255]!) // assistant 平移后落在批尾
    expect(asstRow.sourceSeqs).toEqual([
      evs.find((e) => e.type === 'settings/snapshot')!.seq,
      evs.find((e) => e.type === 'user/message')!.seq,
    ]) // 血缘解析到正确前驱（不错链、不缺段）
    rec.dispose()
    store.close()
  })

  it('失败但未超上限（64 条）：pending 全量保留待重试，无丢弃 warn（不扩大留痕面）', () => {
    const warn = vi.spyOn(log, 'warn').mockReturnValue()
    const { store } = openTmp()
    const sid = store.createSession('书A')
    const fail = { n: 1 }
    withPersistentFailure(store, fail)
    const rec = new SessionRecorder(store, sid)
    rec.add(sessionStartEvent('书A'))
    for (let i = 0; i < 63; i++) rec.add(userMessageEvent(`u${i}`))
    expect(() => rec.flush()).toThrow('模拟 SQLITE_BUSY')
    const inner = rec as unknown as { pending: NewEvent[] }
    expect(inner.pending.length).toBe(64) // 重试语义不变：一批不丢
    expect(warn.mock.calls.map((c) => String(c[1])).filter((m) => m.includes('丢弃'))).toEqual([])
    rec.dispose()
    store.close()
  })
})
