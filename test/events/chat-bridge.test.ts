/**
 * F1-P1 桥接层单测：loadHistoryWithSeqs 映射重建 + SessionRecorder 录制/遮蔽。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, type SessionStore, type NewEvent } from '../../src/events/store.js'
import {
  loadHistoryWithSeqs,
  SessionRecorder,
  sessionStartEvent,
  userMessageEvent,
  assistantMessageEvent,
  toolCallEvent,
  toolResultEvent,
  turnStartEvent,
  turnEndEvent,
} from '../../src/events/chat-bridge.js'
import { deriveMessages, validateEventStream } from '../../src/events/projection.js'

const dirs: string[] = []
function openTmp(): { store: SessionStore; ud: string } {
  const d = mkdtempSync(join(tmpdir(), 'f1-bridge-'))
  dirs.push(d)
  return { store: openSessionStore(d, '/books/a')!, ud: d }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('F1-P1 loadHistoryWithSeqs', () => {
  it('还原 msgs + 每条消息的 seq 映射（tool_result 合并）', () => {
    const { store } = openTmp()
    const sid = store.createSession('书A')
    store.appendEvents(sid, [
      { type: 'session/start', data: {} },
      { type: 'user/message', data: { message: 'u1' }, surfaceOp: 'append' },
      {
        type: 'assistant/message',
        data: { message: [{ type: 'text', text: 'a1' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }] },
        surfaceOp: 'append',
      },
      { type: 'tool/result', data: { callId: 't1', content: 'r1' }, surfaceOp: 'append' },
    ])
    const restored = loadHistoryWithSeqs(store.listEvents('书A'))
    expect(restored.msgs).toHaveLength(3)
    expect(restored.msgs[0]).toEqual({ role: 'user', content: 'u1' })
    expect(restored.msgs[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'r1', isError: false }] })
    // seq 映射：3 条消息 → [[2],[3],[4]]
    expect(restored.seqsPerMsg).toEqual([[2], [3], [4]])
    store.close()
  })

  it('遮蔽后的节点不恢复（压缩后投影一致）', () => {
    const { store } = openTmp()
    const sid = store.createSession('书A')
    store.appendEvents(sid, [
      { type: 'user/message', data: { message: '旧' }, surfaceOp: 'append' },
      { type: 'user/message', data: { message: '新' }, surfaceOp: 'append' },
      {
        type: 'compaction/end',
        data: { reason: 'completed' },
        surfaceOp: 'replace',
        shadowStart: 1,
        shadowEnd: 1,
        sourceSeqs: [1],
      },
    ])
    const restored = loadHistoryWithSeqs(store.listEvents('书A'))
    expect(restored.msgs).toEqual([{ role: 'user', content: '新' }])
    expect(restored.seqsPerMsg).toEqual([[2]])
    store.close()
  })
})

describe('F1-P1 SessionRecorder', () => {
  it('回合级 flush：seq 区间连续 + allSessionSeqs 汇总', () => {
    const { store } = openTmp()
    const sid = store.createSession('书A')
    const rec = new SessionRecorder(store, sid)
    rec.add(sessionStartEvent('书A'))
    const uIdx = rec.add(userMessageEvent('hi'))
    const r1 = rec.flush()!;
    expect(r1).toEqual({ first: 1, last: 2 })
    expect(rec.allSessionSeqs()).toEqual([1, 2])
    // uIdx 是批次内 0-based 序号（user/message 是第 2 个事件 → idx=1）
    expect(r1.first + uIdx).toBe(2)
    const aIdx = rec.add(assistantMessageEvent('reply'))
    const r2 = rec.flush()!;
    expect(r2).toEqual({ first: 3, last: 3 })
    expect(r2.first + aIdx).toBe(3)
    expect(rec.allSessionSeqs()).toEqual([1, 2, 3])
    store.close()
  })

  it('close 遮蔽被裁 seq 区间（压缩走遮蔽）', () => {
    const { store } = openTmp()
    const sid = store.createSession('书A')
    const rec = new SessionRecorder(store, sid)
    rec.add(sessionStartEvent('书A'))
    rec.add(userMessageEvent('旧1'))
    rec.flush()
    rec.add(userMessageEvent('旧2'))
    rec.flush()
    rec.add(userMessageEvent('新'))
    rec.flush()
    // 遮蔽 seq 2-3（旧1、旧2），close 写 session/end + compaction/end replace
    rec.close('completed', [2, 3])
    const msgs = deriveMessages(store.listEvents('书A'))
    expect(msgs).toEqual([{ role: 'user', content: '新' }])
    store.close()
  })

  it('失败回滚：close(reason, allSessionSeqs()) 遮蔽整个会话', () => {
    const { store } = openTmp()
    const sid = store.createSession('书A')
    const rec = new SessionRecorder(store, sid)
    rec.add(sessionStartEvent('书A'))
    rec.add(userMessageEvent('废数据'))
    rec.add(assistantMessageEvent('半截回复'))
    rec.flush()
    // 模拟失败：遮蔽本会话全部已写事件
    rec.close('error', rec.allSessionSeqs())
    expect(deriveMessages(store.listEvents('书A'))).toEqual([])
    store.close()
  })

  it('GG-P2-1: 失败收尾含未落库半截组——closeMaskingAll 先 flush 再遮蔽，无幽灵消息', () => {
    const { store } = openTmp()
    const sid = store.createSession('书A')
    const rec = new SessionRecorder(store, sid)
    rec.add(sessionStartEvent('书A'))
    rec.add(turnStartEvent(0))
    rec.flush()
    // 首轮失败的真实形态：user + 半截 assistant 还在 pending 未 flush——
    // 旧写法 close('error', allSessionSeqs()) 的遮蔽列表不含 pending 组，
    // close 内部落库后投影重放出模型从未成功产出的「幽灵消息」
    rec.add(turnStartEvent(1))
    rec.add({ type: 'settings/snapshot', data: { scope: 'settings', digest: 'd' } })
    rec.add(userMessageEvent('第一问'))
    rec.add(assistantMessageEvent('半截回复'))
    rec.closeMaskingAll('error')
    // 全会话消息（含半截组）被遮蔽：投影零消息；结构事件不遮（骨架保留），
    // session/end 保留为失败终态；遮蔽契约过校验链（只盖曾可见节点）
    expect(deriveMessages(store.listEvents('书A'))).toEqual([])
    const evs = store.listEvents('书A')
    expect(evs.some((e) => e.type === 'session/end' && e.data['reason'] === 'error')).toBe(true)
    expect(validateEventStream(evs)).toEqual([])
    store.close()
  })

  it('RB-IF-P1-2: close 的 archiveSeq 用真实 seq——并发写方在场不错链到外来事件', () => {
    const { store } = openTmp()
    const sid = store.createSession('书A')
    const rec = new SessionRecorder(store, sid)
    rec.add(sessionStartEvent('书A'))
    rec.add(userMessageEvent('旧'))
    const r = rec.flush()!
    // 模拟多窗口并发写：触发器在每次 INSERT 后替「另一窗口」补插一行——旧实现
    // lastSeq()+2 推算会把外来行当 archiveSeq（错链），INSERT RETURNING 真实 seq 不受影响
    const other = new DatabaseSync(store.dbPath)
    other.exec(
      `CREATE TRIGGER other_window AFTER INSERT ON events BEGIN
         INSERT INTO events (session_id, type, data, replace_generation, created_at)
         VALUES ('other-window', 'note', '{}', 0, 0);
       END`,
    )
    try {
      const archiveSeq = rec.close('completed', [r.first, r.last], '存档内容')
      const evs = store.listEvents('书A')
      const archive = evs.find((e) => e.type === 'compaction/end' && e.data['message'] === '存档内容')
      expect(archive).toBeDefined()
      expect(archiveSeq).toBe(archive!.seq) // 指向自身的 compaction/end 事件
      // 外来行确实插在了 compaction 事件紧邻位置（证明并发窗口存在），archiveSeq 未取到它
      const foreign = other.prepare(
        `SELECT MIN(seq) AS m, MAX(seq) AS m2 FROM events WHERE session_id = 'other-window' AND type = 'note'`,
      ).get() as { m: number; m2: number }
      expect(foreign.m2!).toBeGreaterThanOrEqual(archive!.seq - 1)
      expect(archiveSeq).not.toBe(foreign.m2!)
    } finally {
      other.exec('DROP TRIGGER other_window')
      other.close()
      store.close()
    }
  })

  it('工具往返录制：tool/call 审计 + tool/result 合并 seq', () => {
    const { store } = openTmp()
    const sid = store.createSession('书A')
    const rec = new SessionRecorder(store, sid)
    rec.add(sessionStartEvent('书A'))
    rec.add(userMessageEvent('检查'))
    rec.add(turnEndEvent(0, 'completed'))
    rec.flush()
    const aIdx = rec.add(assistantMessageEvent([{ type: 'tool_use', id: 't1', name: 'check_chapter', input: {} }]))
    rec.add(toolCallEvent('t1', 'check_chapter', { chapter: 3 }))
    const trIdx = rec.add(toolResultEvent('t1', '全绿'))
    rec.add(turnEndEvent(1, 'completed'))
    const r2 = rec.flush()!;
    expect(r2.first + aIdx).toBe(4)
    expect(r2.first + trIdx).toBe(6)
    store.close()
  })
})


// ── R62-10/R62-11（第六十二轮）──────────────────────────

describe('R62-10/R62-11：close 可重试性 + 空载荷遮蔽过滤', () => {
  it('R62-10：close 首 flush 失败 → ended 回滚 + end 撤回，重试成功且无双写', () => {
    let failOnce = true
    const appended: NewEvent[][] = []
    const fake = {
      appendEventsResolveLineage(_sid: string, evs: NewEvent[]): number[] {
        if (failOnce) {
          failOnce = false
          throw new Error('模拟 SQLITE_BUSY')
        }
        appended.push(evs)
        return evs.map((_, i) => 100 + i)
      },
    } as unknown as SessionStore
    const rec = new SessionRecorder(fake, 's1')
    rec.add(userMessageEvent('hi'))
    // 修复前：ended=true 先置，flush 抛错后幂等闸挡住重试，session/end 永不落库
    expect(() => rec.close('completed')).toThrow('模拟 SQLITE_BUSY')
    expect(rec.close('completed')).toBeNull() // 无遮蔽/存档 → null；session/end 已入库
    expect(appended).toHaveLength(1) // 重试恰好一批
    expect(appended[0]!.map((e) => e.type)).toEqual(['user/message', 'session/end']) // 恰一个 end，无双写
    rec.dispose()
  })

  it('R62-11：空载荷 assistant/message（usage 壳）不入遮蔽区间——closeMaskingAll 产出的流过 validateEventStream 无「未可见 seq」', () => {
    const { store } = openTmp()
    const sid = store.createSession('书A')
    const rec = new SessionRecorder(store, sid)
    rec.add(sessionStartEvent('书A'))
    rec.add(userMessageEvent('hi'))
    rec.add(assistantMessageEvent('')) // 空文本：foldSurface 跳过（永不成为可见节点）
    rec.flush()
    rec.closeMaskingAll('completed')
    // 修复前：该 seq 进遮蔽区间 → 校验报「遮蔽区间含未可见 seq」（契约与实现不符）
    const issues = validateEventStream(store.listEvents(sid))
    expect(issues.filter((i) => i.message.includes('未可见'))).toEqual([])
    store.close()
  })
})
