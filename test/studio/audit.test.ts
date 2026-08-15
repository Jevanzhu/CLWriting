/**
 * F1-P5 审计 buildAuditView 单测：事件重放 + 遮蔽差异（模型可见 vs 人类可见）+
 * 血缘 sourceSeqs + 工作流事件分组。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { SessionRecorder, userMessageEvent, assistantMessageEvent, sessionStartEvent } from '../../src/events/chat-bridge.js'
import { stepStartEvent, llmCallEvent } from '../../src/events/chain-bridge.js'
import { buildAuditView } from '../../src/studio/server/api/audit.js'

function withStore<T>(fn: (store: NonNullable<ReturnType<typeof openSessionStore>>, bookRoot: string) => T): T {
  const userData = mkdtempSync(join(tmpdir(), 'audit-'))
  const bookRoot = join(userData, 'books', 'x')
  const store = openSessionStore(userData, bookRoot)!
  try {
    return fn(store, bookRoot)
  } finally {
    store.close()
    rmSync(userData, { recursive: true, force: true })
  }
}

describe('F1-P5 buildAuditView', () => {
  it('对话：无遮蔽 → modelVisible = humanVisible，遮蔽数 0', () => {
    withStore((store) => {
      const sid = store.createSession('conv', { book: 'conv' })
      store.appendEvents(sid, [
        userMessageEvent('你好'),
        assistantMessageEvent('你好呀'),
      ])
      const { conversation } = buildAuditView(store, 'conv', '/tmp/nonexistent')
      expect(conversation).not.toBeNull()
      expect(conversation!.shadowedCount).toBe(0)
      expect(conversation!.modelVisible).toHaveLength(2)
      expect(conversation!.humanVisible).toHaveLength(2)
      expect(conversation!.modelVisible.map((n) => n.seq)).toEqual(conversation!.humanVisible.map((n) => n.seq))
    })
  })

  it('对话：replace 遮蔽 → modelVisible 不含被遮蔽节点，humanVisible 含（shadowed 标记）', () => {
    withStore((store) => {
      const sid = store.createSession('conv', { book: 'conv' })
      store.appendEvents(sid, [
        userMessageEvent('怎么写开头？'),
        assistantMessageEvent('旧版回复：硬闯。'),
        // compaction/end 遮蔽 [2,2]：旧回复被遮蔽（P1 压缩语义）
        { type: 'compaction/end', data: { summary: '压缩' }, shadowStart: 2, shadowEnd: 2 },
        assistantMessageEvent('新版回复：谈判。'),
      ])
      const { conversation } = buildAuditView(store, 'conv', '/tmp/nonexistent')
      expect(conversation).not.toBeNull()
      expect(conversation!.shadowedCount).toBe(1)
      expect(conversation!.modelVisible.map((n) => n.seq)).toEqual([1, 4])
      const human = conversation!.humanVisible
      expect(human.map((n) => n.seq)).toEqual([1, 2, 4])
      expect(human.find((n) => n.seq === 2)!.shadowed).toBe(true)
      expect(human.find((n) => n.seq === 4)!.shadowed).toBe(false)
      const ev = conversation!.events.find((e) => e.seq === 2)!
      expect(ev.shadowed).toBe(true)
    })
  })

  it('对话：assistant sourceSeqs 血缘透出（可回溯）', () => {
    withStore((store) => {
      const sid = store.createSession('conv', { book: 'conv' })
      const rec = new SessionRecorder(store, sid)
      rec.add(sessionStartEvent('conv'))
      rec.add(userMessageEvent('如何铺垫伏笔？'))
      const snapIdx = rec.add({ type: 'settings/snapshot', data: { scope: 'settings', digest: 'abc' }, surfaceOp: 'append' })
      rec.add(assistantMessageEvent('埋笔要早。', undefined, undefined, [snapIdx]))
      rec.flush()

      const { conversation } = buildAuditView(store, 'conv', '/tmp/nonexistent')
      const asst = conversation!.events.find((e) => e.type === 'assistant/message')!
      expect(asst.sourceSeqs).toBeDefined()
      expect(asst.sourceSeqs!.length).toBeGreaterThan(0)
      for (const s of asst.sourceSeqs!) {
        expect(conversation!.events.some((e) => e.seq === s)).toBe(true)
      }
    })
  })

  it('工作流：ws 会话 step/llm-call 事件归入 workflowEvents', () => {
    withStore((store, bookRoot) => {
      const sid = store.workspaceSession(bookHash(bookRoot))
      store.appendEvents(sid, [
        stepStartEvent('自愈', 'review'),
        llmCallEvent({
          runId: 'r1',
          task: 'review',
          tierKind: 'deep',
          model: 'gpt-x',
          attempt: 0,
          stopReason: 'end_turn',
          durationMs: 10,
          ok: true,
        }),
      ])
      const { conversation, workflowEvents } = buildAuditView(store, 'conv', bookRoot)
      expect(conversation).toBeNull()
      expect(workflowEvents.map((e) => e.type)).toEqual(['step/start', 'llm/call'])
    })
  })
})

