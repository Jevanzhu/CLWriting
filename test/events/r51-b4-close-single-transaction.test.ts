/**
 * R51-B-4（五十一轮）回归：SessionRecorder.close 多遮蔽段并单事务。
 *
 * 原实现对多遮蔽段逐段独立 appendEvents——第二段起失败（SQLITE_BUSY 耗尽/磁盘满）
 * 留「首段已遮蔽、其余未遮蔽」半态，且 close 幂等闸已开不回滚，重试被关死。修复：
 * 全段并单事务（appendEvents 内部 BEGIN..COMMIT），要么全遮蔽要么全不动。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, type SessionStore } from '../../src/events/store.js'
import { SessionRecorder, sessionStartEvent, userMessageEvent } from '../../src/events/chat-bridge.js'
import { deriveMessages } from '../../src/events/projection.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []
function openTmp(): { store: SessionStore; ud: string } {
  const d = mkdtempTracked(join(tmpdir(), 'r51-b4-'))
  dirs.push(d)
  return { store: openSessionStore(d, '/books/a')!, ud: d }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 造非连续遮蔽面（两段以上）：分批 flush 使 surface seq 离散 */
function seedDisjoint(rec: SessionRecorder, store: SessionStore): number[] {
  rec.add(sessionStartEvent('书A'))
  rec.add(userMessageEvent('甲'))
  rec.flush() // seq 1-2
  rec.add(userMessageEvent('乙'))
  rec.flush() // seq 3
  rec.add(userMessageEvent('丙'))
  rec.flush() // seq 4
  void store
  return [2, 4] // 两段：[2,2] 与 [4,4]
}

describe('R51-B-4: close 多遮蔽段单事务', () => {
  it('多段遮蔽一次 appendEvents 落库：全段生效 + 存档在首段 + 幂等收口', () => {
    const { store } = openTmp()
    const sid = store.createSession('书A')
    const calls: unknown[][] = []
    const spy = {
      appendEvents(s: string, evs: unknown[]): number[] {
        calls.push(evs as unknown[])
        return store.appendEvents(s, evs as never)
      },
    }
    const wrapped = new SessionRecorder({ ...store, ...spy } as SessionStore, sid)
    const shadow = seedDisjoint(wrapped, store)
    const archiveSeq = wrapped.close('completed', shadow, '累计存档')
    // 单事务：compaction 批只落一次（修复前逐段两次调用）
    expect(calls).toHaveLength(1)
    // 全段生效：两段 compaction/start + compaction/end 齐备（无半态）
    const evs = store.listEvents('书A')
    expect(evs.filter((e) => e.type === 'compaction/start')).toHaveLength(2)
    expect(evs.filter((e) => e.type === 'compaction/end')).toHaveLength(2)
    // 遮蔽面 [2,2]+[4,4]：甲、丙被遮蔽，段间未遮蔽的乙保持可见；
    // Y-P2-2：携带存档的首段 compaction/end 以 user-text 投影在首段原位（甲的位置）
    const visible = deriveMessages(store.listEvents('书A'))
    expect(visible).toHaveLength(2)
    expect(visible[0]!.content).toBe('累计存档')
    expect(visible[1]!.content).toBe('乙')
    // 存档挂在批内首个 compaction/end（seq = 批内第 2 个真实 seq）
    const archive = evs.find((e) => e.type === 'compaction/end' && e.data['message'] === '累计存档')
    expect(archiveSeq).toBe(archive!.seq)
    // 幂等收口不变
    expect(wrapped.close('completed')).toBeNull()
  })

  it('失败原子性：落库失败 → 全部遮蔽段都不落（无「首段已遮蔽」半态）', () => {
    const { store } = openTmp()
    const sid = store.createSession('书A')
    const rec = new SessionRecorder(store, sid)
    const shadow = seedDisjoint(rec, store)
    const broken = new SessionRecorder(
      {
        ...store,
        appendEvents: () => {
          throw new Error('模拟 SQLITE_BUSY 耗尽/磁盘满')
        },
      } as SessionStore,
      sid,
    )
    expect(() => broken.close('error', shadow)).toThrow('SQLITE_BUSY')
    // 全有或全无：任何 compaction 段都未落库（修复前首段已提交 = 部分遮蔽半态）
    const evs = store.listEvents('书A')
    expect(evs.some((e) => e.type === 'compaction/start' || e.type === 'compaction/end')).toBe(false)
    // session/end 已在库（首 flush 成功），消息投影未被遮蔽（内容完整可审计）
    expect(evs.some((e) => e.type === 'session/end')).toBe(true)
    expect(deriveMessages(evs).length).toBe(3)
    store.close()
  })
})
