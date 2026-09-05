/**
 * PM-10（2026-09-05 性能与内存专项）：GET /chat/history limit 尾窗等价性护栏。
 *
 * 审查项原记「JSONL 事件日志 readFileSync 全量读 + split + 逐行 JSON.parse 后才
 * slice(-limit) 截尾」——事件库 F1 起已是 node:sqlite（每书一库），listEvents 走
 * SQL 游标流式 iterate + 逐行坏行降级（store.ts 内存闸 B1 / R65-20），字节级文件
 * 尾读（statSync / 末尾 64KB 窗 / 半行丢弃）无附着对象；且响应契约 total/truncated
 * 是「全量投影消息数 / 截断标记」，截尾只能发生在消息合成之后（连续 tool-result
 * 合成消息的 blocks 不可拆）——详见 buildChatHistoryView 头注释。
 *
 * 本文件把「全量取数 → selectBranch → loadHistoryWithSeqs → slice(-limit)」内嵌为
 * 参照实现，逐位（toStrictEqual）断言 buildChatHistoryView 在各库形态 / limit 边界
 * 下与参照一致：小库=全量、远超 64KB 大库取尾、坏行容错、恰 limit / 不足 limit、
 * 分支视图、空库。未来 store 层若落地真尾窗（seq 降序取尾 + 窗口翻倍前扩、不足退
 * 化为全量），本护栏必须保持全绿——任何一条红即尾窗破坏了逐位等价。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { bookHash, openSessionStore, type NewEvent, type SessionStore } from '../../src/events/store.js'
import {
  assistantMessageEvent,
  loadHistoryWithSeqs,
  toolResultEvent,
  userMessageEvent,
} from '../../src/events/chat-bridge.js'
import { buildBranchTree, defaultBranchId, selectBranch } from '../../src/events/branch-tree.js'
import { buildChatHistoryView } from '../../src/studio/server/api/chat-history.js'

/** 参照实现（内嵌）：与 buildChatHistoryView 现行全量链逐步同构——
 *  全量 listEvents → 分支树定位 → selectBranch 筛选 → 投影合成 → slice 截尾。 */
interface ViewShape {
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
  seqs: number[][]
  branchId: string | null
  truncated: boolean
  total: number
}
function referenceView(store: SessionStore, bookName: string, branchId?: string, limit?: number): ViewShape {
  const all = store.listEvents(bookName)
  const active = branchId ?? defaultBranchId(buildBranchTree(all))
  const events = selectBranch(all, branchId)
  const { msgs, seqsPerMsg } = loadHistoryWithSeqs(events)
  if (limit === undefined || !Number.isFinite(limit) || limit < 1 || msgs.length <= limit) {
    return { messages: msgs, seqs: seqsPerMsg, branchId: active, truncated: false, total: msgs.length }
  }
  return {
    messages: msgs.slice(-limit),
    seqs: seqsPerMsg.slice(-limit),
    branchId: active,
    truncated: true,
    total: msgs.length,
  }
}

/** 每用例独立 tmp userData + 独立 bookHash（互不串库） */
const uds: string[] = []
function makeStore(bookKey: string): { store: SessionStore; sid: string; ud: string } {
  const ud = mkdtempSync(join(tmpdir(), 'pm10-tail-'))
  uds.push(ud)
  const store = openSessionStore(ud, '/pm10/' + bookKey)!
  return { store, sid: store.createSession(bookKey, { book: bookKey }), ud }
}
afterAll(() => {
  for (const ud of uds) rmSync(ud, { recursive: true, force: true })
})

describe('PM-10：chat/history limit 尾窗与「全量投影 + slice」参照逐位一致', () => {
  it('小库全形态：文本/块结构/连续 tool-result 合成/跨行正文——各 limit 与参照逐位一致', () => {
    const { store, sid } = makeStore('小库书')
    try {
      store.appendEvents(sid, [
        userMessageEvent('帮我看看第 1 章\n第二行正文（无尾换行等价：行内容含换行须完整）'),
        assistantMessageEvent([
          { type: 'text', text: '我先检查一下。' },
          { type: 'tool_use', id: 'tu-1', name: 'check_chapter', input: { chapter: 1 } },
        ]),
        toolResultEvent('tu-1', '工具结果 A'),
        toolResultEvent('tu-2', '工具结果 B'),
        toolResultEvent('tu-3', '工具结果 C'),
        assistantMessageEvent('第 1 章检查完毕。'),
      ])
      // 投影形态自检：user + assistant(blocks) + 合成 user(3×tool_result) + assistant = 4 条
      const full = buildChatHistoryView(store, '小库书')
      expect(full.messages).toHaveLength(4)
      expect(full.messages[2]).toEqual({
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tu-1', content: '工具结果 A', isError: false },
          { type: 'tool_result', toolUseId: 'tu-2', content: '工具结果 B', isError: false },
          { type: 'tool_result', toolUseId: 'tu-3', content: '工具结果 C', isError: false },
        ],
      })
      // 各 limit（含 undefined / 1 / 恰全量 4 / 超 99）→ 与参照逐位一致
      for (const limit of [undefined, 1, 2, 3, 4, 99]) {
        expect(buildChatHistoryView(store, '小库书', undefined, limit)).toStrictEqual(
          referenceView(store, '小库书', undefined, limit),
        )
      }
      // 语义直断：limit=1 取尾一条（收尾 assistant）；limit=2 首条是完整合成消息（blocks 不因截尾拆破）
      expect(buildChatHistoryView(store, '小库书', undefined, 1).messages[0]).toEqual({
        role: 'assistant',
        content: '第 1 章检查完毕。',
      })
      const tail2 = buildChatHistoryView(store, '小库书', undefined, 2)
      expect((tail2.messages[0]!.content as Array<{ toolUseId: string }>).map((b) => b.toolUseId)).toEqual([
        'tu-1',
        'tu-2',
        'tu-3',
      ])
    } finally {
      store.close()
    }
  })

  it('大库（约 1MB 正文，远超旧尾读 64KB 窗）：limit=10 取尾正确 + total/truncated 正确 + 与参照逐位一致', () => {
    const { store, sid } = makeStore('大库书')
    try {
      const pad = 'x'.repeat(2048) // 每条消息 ~2KB 正文，480 条 ≈ 1MB > 64KB
      const batch: NewEvent[] = []
      for (let i = 1; i <= 240; i++) {
        batch.push(userMessageEvent(`u-${i} ${pad}`), assistantMessageEvent(`a-${i} ${pad}`))
        if (batch.length >= 40) {
          store.appendEvents(sid, batch)
          batch.length = 0
        }
      }
      if (batch.length > 0) store.appendEvents(sid, batch)

      const view = buildChatHistoryView(store, '大库书', undefined, 10)
      expect(view.total).toBe(480)
      expect(view.truncated).toBe(true)
      expect(view.messages).toHaveLength(10)
      expect(view.seqs).toHaveLength(10)
      // 尾窗取尾部：末 10 条消息 = 第 236~240 回合的 user/assistant 对
      expect(view.messages[0]!.role).toBe('user')
      expect((view.messages[0]!.content as string).startsWith('u-236 ')).toBe(true)
      expect(view.messages[9]).toEqual({ role: 'assistant', content: `a-240 ${pad}` })
      expect(view.messages[8]).toEqual({ role: 'user', content: `u-240 ${pad}` })
      // 平行 seqs 与参照逐位一致
      expect(buildChatHistoryView(store, '大库书', undefined, 10)).toStrictEqual(
        referenceView(store, '大库书', undefined, 10),
      )
    } finally {
      store.close()
    }
  })

  it('恰 limit / 不足 limit 边界：==limit 全量不截、==limit+1 全量不截、不足 limit 截且恰尾、limit=1', () => {
    const { store, sid } = makeStore('边界书')
    try {
      for (let i = 1; i <= 5; i++) {
        store.appendEvents(sid, [userMessageEvent(`u-${i}`), assistantMessageEvent(`a-${i}`)])
      }
      const exactly = buildChatHistoryView(store, '边界书', undefined, 10)
      expect(exactly.total).toBe(10)
      expect(exactly.truncated).toBe(false)
      expect(exactly.messages).toHaveLength(10)
      expect(exactly.messages[0]).toEqual({ role: 'user', content: 'u-1' })

      const over = buildChatHistoryView(store, '边界书', undefined, 11)
      expect(over.truncated).toBe(false)
      expect(over.total).toBe(10)
      expect(over.messages).toHaveLength(10) // limit(11) > 总数(10) → 全量不截
      expect(over.messages[0]).toEqual({ role: 'user', content: 'u-1' })

      const cut = buildChatHistoryView(store, '边界书', undefined, 9)
      expect(cut.truncated).toBe(true)
      expect(cut.messages).toHaveLength(9)
      expect(cut.messages[0]).toEqual({ role: 'assistant', content: 'a-1' }) // 丢首条 u-1，余 9 条
      expect(cut.messages[8]).toEqual({ role: 'assistant', content: 'a-5' })

      expect(buildChatHistoryView(store, '边界书', undefined, 1).messages[0]).toEqual({
        role: 'assistant',
        content: 'a-5',
      })
      for (const limit of [1, 5, 9, 10, 11, 1000]) {
        expect(buildChatHistoryView(store, '边界书', undefined, limit)).toStrictEqual(
          referenceView(store, '边界书', undefined, limit),
        )
      }
    } finally {
      store.close()
    }
  })

  it('坏行容错与参照一致：data 腐蚀行跳过不抛，坏行在尾窗内/外两种摆位逐位一致', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 摆位一：坏行在尾窗外（seq=2，limit=2 只取尾部）
      const a = makeStore('坏行书A')
      try {
        a.store.appendEvents(a.sid, [
          userMessageEvent('u-1'),
          assistantMessageEvent('a-1 会坏'),
          userMessageEvent('u-2'),
          assistantMessageEvent('a-2'),
          userMessageEvent('u-3'),
          assistantMessageEvent('a-3'),
        ])
      } finally {
        a.store.close() // 唯一 close 点（之后才可外部连库腐蚀）
      }
      const dbA = new DatabaseSync(join(a.ud, 'clwriting', 'session', bookHash('/pm10/坏行书A') + '.db'))
      dbA.prepare("UPDATE events SET data = '{oops' WHERE seq = 2").run()
      dbA.close()

      const storeA2 = openSessionStore(a.ud, '/pm10/坏行书A')!
      try {
        const view = buildChatHistoryView(storeA2, '坏行书A', undefined, 2)
        expect(view.messages).toHaveLength(2)
        expect(JSON.stringify(view.messages)).not.toContain('会坏')
        expect(view.truncated).toBe(true)
        // 坏行使全量消息数 6→5，total 与参照同口径；尾窗/全量两种 limit 都逐位一致
        expect(buildChatHistoryView(storeA2, '坏行书A', undefined, 2)).toStrictEqual(
          referenceView(storeA2, '坏行书A', undefined, 2),
        )
        expect(buildChatHistoryView(storeA2, '坏行书A', undefined, 99)).toStrictEqual(
          referenceView(storeA2, '坏行书A', undefined, 99),
        )
      } finally {
        storeA2.close()
      }

      // 摆位二：坏行在尾窗内（末条被腐蚀，limit=2 窗内跳行）
      const b = makeStore('坏行书B')
      try {
        b.store.appendEvents(b.sid, [
          userMessageEvent('u-1'),
          assistantMessageEvent('a-1'),
          userMessageEvent('u-2'),
          assistantMessageEvent('a-2 末条会坏'),
        ])
      } finally {
        b.store.close()
      }
      const dbB = new DatabaseSync(join(b.ud, 'clwriting', 'session', bookHash('/pm10/坏行书B') + '.db'))
      dbB.prepare("UPDATE events SET data = '{oops' WHERE seq = 4").run()
      dbB.close()

      const storeB2 = openSessionStore(b.ud, '/pm10/坏行书B')!
      try {
        // 坏行跳过后全量消息 3 条（u-1, a-1, u-2）→ limit=2 截尾得 [a-1, u-2]
        const view = buildChatHistoryView(storeB2, '坏行书B', undefined, 2)
        expect(view.messages).toHaveLength(2)
        expect(view.messages[1]).toEqual({ role: 'user', content: 'u-2' })
        expect(view.total).toBe(3)
        expect(view.truncated).toBe(true)
        expect(JSON.stringify(view.messages)).not.toContain('会坏')
        expect(buildChatHistoryView(storeB2, '坏行书B', undefined, 2)).toStrictEqual(
          referenceView(storeB2, '坏行书B', undefined, 2),
        )
      } finally {
        storeB2.close()
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('分支视图 + limit：先 selectBranch 后截尾的序钉死——顶替槽剔除后取尾与参照逐位一致', () => {
    const { store, sid } = makeStore('分支书')
    try {
      store.appendEvents(sid, [userMessageEvent('u-1'), assistantMessageEvent('a-1')])
      const r2 = store.appendEvents(sid, [userMessageEvent('u-2'), assistantMessageEvent('a-2 被顶替')])
      // regenerate：对 u-2（r2 首条 user）生成变体组 reg-1 → 成为最新组（默认分支）
      store.appendEvents(sid, [
        assistantMessageEvent('a-2 v2 新答案', undefined, undefined, undefined, {
          parentSeq: r2[0],
          branchId: 'reg-1',
        }),
      ])
      store.appendEvents(sid, [userMessageEvent('u-3'), assistantMessageEvent('a-3')])

      // 默认分支视图：顶替槽 (u-2, 组根) 内的旧答案 a-2 被剔除 → 6 条消息
      const full = buildChatHistoryView(store, '分支书')
      expect(full.branchId).toBe('reg-1')
      expect(full.total).toBe(6)
      expect(JSON.stringify(full.messages)).not.toContain('被顶替')

      const view = buildChatHistoryView(store, '分支书', undefined, 4)
      expect(view.truncated).toBe(true)
      // 截尾发生在合成/筛选之后：尾 4 条 = u-2, a-2v2, u-3, a-3
      expect(view.messages.map((m) => (typeof m.content === 'string' ? m.content : '(blocks)'))).toEqual([
        'u-2',
        'a-2 v2 新答案',
        'u-3',
        'a-3',
      ])
      // 缺省与显式 branchId 两条路都与参照逐位一致
      expect(buildChatHistoryView(store, '分支书', undefined, 4)).toStrictEqual(
        referenceView(store, '分支书', undefined, 4),
      )
      expect(buildChatHistoryView(store, '分支书', 'reg-1', 4)).toStrictEqual(
        referenceView(store, '分支书', 'reg-1', 4),
      )
      expect(buildChatHistoryView(store, '分支书', 'reg-1')).toStrictEqual(referenceView(store, '分支书', 'reg-1'))
    } finally {
      store.close()
    }
  })

  it('空库：limit 不变契约——空 messages + truncated=false + total=0，与参照一致', () => {
    const { store } = makeStore('空库书')
    try {
      for (const limit of [undefined, 10]) {
        expect(buildChatHistoryView(store, '空库书', undefined, limit)).toStrictEqual({
          messages: [],
          seqs: [],
          branchId: null,
          truncated: false,
          total: 0,
        })
        expect(buildChatHistoryView(store, '空库书', undefined, limit)).toStrictEqual(
          referenceView(store, '空库书', undefined, limit),
        )
      }
    } finally {
      store.close()
    }
  })
})
