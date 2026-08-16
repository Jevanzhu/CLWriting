/**
 * F1-P1 桥接层单测：loadHistoryWithSeqs 映射重建 + SessionRecorder 录制/遮蔽。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, type SessionStore } from '../../src/events/store.js'
import {
  loadHistoryWithSeqs,
  SessionRecorder,
  sessionStartEvent,
  userMessageEvent,
  assistantMessageEvent,
  toolCallEvent,
  toolResultEvent,
  turnEndEvent,
} from '../../src/events/chat-bridge.js'
import { deriveMessages } from '../../src/events/projection.js'

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

