/**
 * Y-P2-5 GET /api/books/:name/chat/history 集成测（HTTP 层）：
 * 事件库投影 → 前端历史消息（user 文本 / assistant 块结构 / tool_result 合成）。
 *
 * harness：tmp workDir + books.jsonl + tmp userData 预置事件（openSessionStore 直写）→
 * startServer 起 HTTP → fetch 断言（GET 无需 token）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { openSessionStore } from '../../src/events/store.js'
import { userMessageEvent, assistantMessageEvent, toolResultEvent } from '../../src/events/chat-bridge.js'

const BOOK = '历史测试书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''

/** 预置事件：直开事件库写一轮带工具往返的对话（构造函数自带 surfaceOp: 'append'） */
function presetEvents(): void {
  const bookRoot = join(workDir, BOOK)
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    const sid = store.createSession(BOOK, { book: BOOK })
    store.appendEvents(sid, [
      userMessageEvent('帮我看看第 1 章'),
      assistantMessageEvent(
        [
          { type: 'text', text: '我先检查一下。' },
          { type: 'tool_use', id: 'tu-1', name: 'check_chapter', input: { chapter: 1 } },
        ],
      ),
      toolResultEvent('tu-1', '全绿，无红项'),
      assistantMessageEvent('第 1 章检查完毕，钩子和节奏都没问题。'),
    ])
  } finally {
    store.close()
  }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-chat-history-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-chat-history-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 历史测试书\n  genre: 玄幻\nhost: cc\n')

  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

async function get(path: string): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`)
  return { status: r.status, json: await r.json().catch(() => null) }
}

describe('Y-P2-5 GET /api/books/:name/chat/history', () => {
  it('空库（无事件）→ 200 + 空 messages', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/chat/history`)
    expect(r.status).toBe(200)
    // L-S2（第八轮）：响应新增 truncated/total（尾窗分页字段）
    expect(r.json).toEqual({ messages: [], seqs: [], branchId: null, truncated: false, total: 0 })
  })

  it('书名不存在 → 404 + 错误信封', async () => {
    const r = await get(`/api/books/${encodeURIComponent('不存在')}/chat/history`)
    expect(r.status).toBe(404)
    expect((r.json as { error: string }).error).toContain('不存在')
  })

  it('预置 user/assistant/tool_result 事件 → 正确投影（tool_result 合成一条 user 消息）', async () => {
    presetEvents()
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/chat/history`)
    expect(r.status).toBe(200)
    const j = r.json as {
      messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>
      seqs: number[][]
      branchId: string | null
    }
    expect(j.messages).toHaveLength(4)
    // 1. user 纯文本
    expect(j.messages[0]).toEqual({ role: 'user', content: '帮我看看第 1 章' })
    // 2. assistant 块结构（text + tool_use 原样透出）
    expect(j.messages[1]!.role).toBe('assistant')
    expect(Array.isArray(j.messages[1]!.content)).toBe(true)
    const blocks = j.messages[1]!.content as Array<Record<string, unknown>>
    expect(blocks[0]).toEqual({ type: 'text', text: '我先检查一下。' })
    expect(blocks[1]).toEqual({ type: 'tool_use', id: 'tu-1', name: 'check_chapter', input: { chapter: 1 } })
    // 3. tool_result 合成一条 user 消息（callId → toolUseId + content）
    expect(j.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'tu-1', content: '全绿，无红项', isError: false }],
    })
    // 4. 收尾 assistant 文本
    expect(j.messages[3]).toEqual({ role: 'assistant', content: '第 1 章检查完毕，钩子和节奏都没问题。' })
    // G1：seqs 与 messages 平行逐条对位；线性书（无分支元数据）branchId=null 且消息一条不丢
    expect(j.seqs).toEqual([[1], [2], [3], [4]])
    expect(j.branchId).toBeNull()
  })

  it('被遮蔽事件（compaction replace）不进投影', async () => {
    // 直接再写一段被遮蔽的回合：旧 assistant 被 compaction/end replace 遮蔽
    const bookRoot = join(workDir, BOOK)
    const store = openSessionStore(userDataPath, bookRoot)!
    try {
      const sid = store.createSession(BOOK, { book: BOOK })
      const before = store.lastSeq()
      store.appendEvents(sid, [assistantMessageEvent('这条会被遮蔽')])
      store.appendEvents(sid, [
        { type: 'compaction/end', data: { reason: 'completed' }, surfaceOp: 'replace', shadowStart: before + 1, shadowEnd: before + 1, sourceSeqs: [before + 1] },
      ])
    } finally {
      store.close()
    }
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/chat/history`)
    expect(r.status).toBe(200)
    const j = r.json as { messages: Array<{ content: string | Array<Record<string, unknown>> }>; seqs: number[][] }
    // 遮蔽消息不出现（上一轮 4 条不变）；被遮蔽 seq 也不进 seqs
    expect(j.messages).toHaveLength(4)
    expect(JSON.stringify(j.messages)).not.toContain('这条会被遮蔽')
    expect(j.seqs).toEqual([[1], [2], [3], [4]])
  })
})

describe('L-S2（第八轮）：GET /chat/history ?limit= 尾窗', () => {
  it('limit=2 → 只回最后 2 条 + truncated=true + total=全量数；limit 大于总数 → 全量', async () => {
    // 事件库沿用上方用例预置（appendEvents 累积，总数动态取）
    const full = await get(`/api/books/${encodeURIComponent(BOOK)}/chat/history`)
    const total = (full.json as { total: number }).total
    expect(total).toBeGreaterThanOrEqual(4)

    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/chat/history?limit=2`)
    expect(r.status).toBe(200)
    const j = r.json as { messages: unknown[]; truncated: boolean; total: number }
    expect(j.messages).toHaveLength(2)
    expect(j.truncated).toBe(true)
    expect(j.total).toBe(total)
    // 尾窗取尾部：最后一条是收尾 assistant 文本
    const last = j.messages[1] as { role: string; content: unknown }
    expect(last.role).toBe('assistant')

    const big = await get(`/api/books/${encodeURIComponent(BOOK)}/chat/history?limit=${total + 10}`)
    const jb = big.json as { messages: unknown[]; truncated: boolean }
    expect(jb.messages).toHaveLength(total)
    expect(jb.truncated).toBe(false)
  })
})
