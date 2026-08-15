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
import { stepStartEvent, llmCallEvent, goalChangeEvent, todoWriteEvent } from '../../src/events/chain-bridge.js'
import { buildAuditView, parseAuditPaging } from '../../src/studio/server/api/audit.js'

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

  it('F5：goal/todo 事件重放为当前态快照（goals + todos 字段）', () => {
    withStore((store, bookRoot) => {
      const sid = store.workspaceSession(bookHash(bookRoot))
      store.appendEvents(sid, [
        goalChangeEvent({
          operation: 'create',
          goal: { id: 'self-heal:ch1', title: '修复第1章红项', state: 'active', roundsStarted: 0, createdAt: 1, updatedAt: 1 },
        }),
        todoWriteEvent({
          todos: [
            { text: '写第1章首稿', state: 'completed' },
            { text: '机检第1章', state: 'in_progress' },
            { text: '修复第1章红项', state: 'pending' },
          ],
        }),
        goalChangeEvent({
          operation: 'complete',
          goal: { id: 'self-heal:ch1', title: '修复第1章红项', state: 'complete', roundsStarted: 1, createdAt: 1, updatedAt: 2 },
        }),
        todoWriteEvent({
          todos: [
            { text: '写第1章首稿', state: 'completed' },
            { text: '机检第1章', state: 'completed' },
            { text: '修复第1章红项', state: 'completed' },
          ],
        }),
      ])
      const { goals, todos } = buildAuditView(store, 'conv', bookRoot)
      expect(goals).toHaveLength(1)
      expect(goals[0]!.id).toBe('self-heal:ch1')
      expect(goals[0]!.state).toBe('complete')
      expect(goals[0]!.roundsStarted).toBe(1)
      expect(todos.map((t) => t.state)).toEqual(['completed', 'completed', 'completed'])
    })
  })

  it('F5：无 goal/todo 事件 → goals/todos 为空数组（不炸端点）', () => {
    withStore((store, bookRoot) => {
      const sid = store.workspaceSession(bookHash(bookRoot))
      store.appendEvents(sid, [stepStartEvent('自愈', 'review')])
      const { goals, todos } = buildAuditView(store, 'conv', bookRoot)
      expect(goals).toEqual([])
      expect(todos).toEqual([])
    })
  })
})

describe('AA-P2-1/AA-P2-2: audit 分页', () => {
  /** 造 N 条对话消息（N 条 user + N 条 assistant = 2N 事件，全部一次 append） */
  function seedConvo(store: NonNullable<ReturnType<typeof openSessionStore>>, n: number): void {
    const sid = store.createSession('conv', { book: 'conv' })
    const evs: Parameters<typeof store.appendEvents>[1] = []
    for (let i = 0; i < n; i++) {
      evs.push(userMessageEvent(`消息${i}`))
      evs.push(assistantMessageEvent(`回复${i}`))
    }
    store.appendEvents(sid, evs)
  }

  it('默认 limit=500 截断 + eventsTotal 全量（长书 >500 不一次全量进响应）', () => {
    withStore((store) => {
      seedConvo(store, 400) // 800 条事件 > 默认 500
      const { conversation } = buildAuditView(store, 'conv', '/tmp/nonexistent')
      expect(conversation).not.toBeNull()
      expect(conversation!.eventsTotal).toBe(800)
      expect(conversation!.events).toHaveLength(500) // 默认页截断
      // listEvents 升序 → 首页为最早 500 条
      expect(conversation!.events[0]!.seq).toBe(1)
      expect(conversation!.events[499]!.seq).toBe(500)
    })
  })

  it('分页参数透传：offset 推进 → 后页切片（total 恒全量，切片不重叠）', () => {
    withStore((store) => {
      seedConvo(store, 10) // 20 条
      const page1 = buildAuditView(store, 'conv', '/tmp/nonexistent', { limit: 8, offset: 0 })
      expect(page1.conversation!.events).toHaveLength(8)
      expect(page1.conversation!.eventsTotal).toBe(20)
      expect(page1.conversation!.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      const page2 = buildAuditView(store, 'conv', '/tmp/nonexistent', { limit: 8, offset: 8 })
      expect(page2.conversation!.events.map((e) => e.seq)).toEqual([9, 10, 11, 12, 13, 14, 15, 16])
      const page3 = buildAuditView(store, 'conv', '/tmp/nonexistent', { limit: 8, offset: 16 })
      expect(page3.conversation!.events.map((e) => e.seq)).toEqual([17, 18, 19, 20])
      // 切片拼接 = 全量（无重叠无遗漏）
      const all = [...page1.conversation!.events, ...page2.conversation!.events, ...page3.conversation!.events]
      expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    })
  })

  it('offset 出界 → 自然空页（total 仍全量，不炸）', () => {
    withStore((store) => {
      seedConvo(store, 2) // 4 条
      const { conversation } = buildAuditView(store, 'conv', '/tmp/nonexistent', { limit: 500, offset: 999 })
      expect(conversation!.events).toHaveLength(0)
      expect(conversation!.eventsTotal).toBe(4)
    })
  })

  it('workflowTotal 透出：工作流事件同样按页截断 + 总数', () => {
    withStore((store, bookRoot) => {
      const sid = store.workspaceSession(bookHash(bookRoot))
      const evs: Parameters<typeof store.appendEvents>[1] = []
      for (let i = 0; i < 12; i++) evs.push(stepStartEvent(`步骤${i}`, 'review'))
      store.appendEvents(sid, evs)
      const { workflowEvents, workflowTotal } = buildAuditView(store, 'conv', bookRoot, { limit: 5, offset: 0 })
      expect(workflowTotal).toBe(12)
      expect(workflowEvents).toHaveLength(5)
    })
  })
})

describe('AA-P2-2: limit 夹取（分页保护不可打穿）', () => {
  it('limit=0 / 负 / 非法 → 回缺省 500', () => {
    expect(parseAuditPaging('0', null)).toEqual({ limit: 500, offset: 0 })
    expect(parseAuditPaging('-3', null)).toEqual({ limit: 500, offset: 0 })
    expect(parseAuditPaging('abc', null)).toEqual({ limit: 500, offset: 0 })
    expect(parseAuditPaging('', null)).toEqual({ limit: 500, offset: 0 })
    expect(parseAuditPaging(null, null)).toEqual({ limit: 500, offset: 0 })
  })

  it('limit 超大 → 夹取到 500（999999999 不能打穿截断）', () => {
    expect(parseAuditPaging('999999999', null)).toEqual({ limit: 500, offset: 0 })
  })

  it('合法 limit/offset 原样保留', () => {
    expect(parseAuditPaging('100', '200')).toEqual({ limit: 100, offset: 200 })
  })

  it('offset 非法/负 → 0（无上界，出界自然空页）', () => {
    expect(parseAuditPaging(null, '-1')).toEqual({ limit: 500, offset: 0 })
    expect(parseAuditPaging(null, 'x')).toEqual({ limit: 500, offset: 0 })
  })
})

