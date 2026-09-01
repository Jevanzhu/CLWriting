/**
 * G1 分支端点集成测（HTTP 层）：
 * GET /api/books/:name/chat/branches（分支列表）+ history 的分支视图（?branch= 切换）。
 *
 * harness：tmp workDir + books.jsonl + tmp userData 预置事件（openSessionStore 直写，
 * 事件用 chat-bridge 构造器——regenerate 真实形状：assistant 带 parentSeq+branchId，
 * user 无分支字段）→ startServer 起 HTTP → fetch 断言（GET 无需 token）。
 * 另起一台无 userDataPath 的 server 验证「无事件库 = 无分支，不报错」。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { startServerSafe } from '../helpers/safe-port.js'
import { openSessionStore } from '../../src/events/store.js'
import { userMessageEvent, assistantMessageEvent, toolResultEvent } from '../../src/events/chat-bridge.js'

const BRANCH_BOOK = '分支测试书'
const LINEAR_BOOK = '线性测试书'
const EMPTY_BOOK = '空测试书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
// 无 userDataPath（无事件库）的对照 server
let bareWorkDir = ''
let bareServer: http.Server | undefined
let bareBaseUrl = ''

/** 建书目录骨架 + books.jsonl 追加一行 */
function makeBook(dir: string, name: string): void {
  const bookRoot = join(dir, name)
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${name}\n  genre: 玄幻\nhost: cc\n`)
  const jsonl = join(dir, '.clwriting', 'books.jsonl')
  writeFileSync(jsonl, JSON.stringify({ name, path: name, kind: 'long' }) + '\n', { flag: 'a' })
}

/** 多分支书：同 parentSeq=1 两个 branchId（b1 两次生成 + b2 新组），模拟 regenerate 落库 */
function presetBranchBook(): void {
  const store = openSessionStore(userDataPath, join(workDir, BRANCH_BOOK))!
  try {
    const sid = store.createSession(BRANCH_BOOK, { book: BRANCH_BOOK })
    store.appendEvents(sid, [
      userMessageEvent('第 3 章写得如何？'), // seq1（user 无分支字段）
      assistantMessageEvent('初版评价：节奏偏慢。', undefined, undefined, undefined, { parentSeq: 1, branchId: 'b1' }), // seq2
      assistantMessageEvent('同组第二次：钩子偏弱。', undefined, undefined, undefined, { parentSeq: 1, branchId: 'b1' }), // seq3
      assistantMessageEvent('新组回答：整体不错，结尾稍急。', undefined, undefined, undefined, { parentSeq: 1, branchId: 'b2' }), // seq4
    ])
  } finally {
    store.close()
  }
}

/** 线性书（无分支元数据）：一轮带连续两个 tool-result 的往返 */
function presetLinearBook(): void {
  const store = openSessionStore(userDataPath, join(workDir, LINEAR_BOOK))!
  try {
    const sid = store.createSession(LINEAR_BOOK, { book: LINEAR_BOOK })
    store.appendEvents(sid, [
      userMessageEvent('帮我检查全书'), // seq1
      assistantMessageEvent([ // seq2
        { type: 'text', text: '我查两项。' },
        { type: 'tool_use', id: 'tu-1', name: 'check_outline', input: {} },
        { type: 'tool_use', id: 'tu-2', name: 'check_rhythm', input: {} },
      ]),
      toolResultEvent('tu-1', '大纲全绿'), // seq3
      toolResultEvent('tu-2', '节奏两处偏慢'), // seq4
      assistantMessageEvent('检查完毕：大纲没问题，节奏两处偏慢。'), // seq5
    ])
  } finally {
    store.close()
  }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-chat-branches-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-chat-branches-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  makeBook(workDir, BRANCH_BOOK)
  makeBook(workDir, LINEAR_BOOK)
  makeBook(workDir, EMPTY_BOOK)
  presetBranchBook()
  presetLinearBook()

  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // 对照组：无 userDataPath（无事件库）
  bareWorkDir = mkdtempSync(join(tmpdir(), 'clwriting-chat-branches-bare-'))
  mkdirSync(join(bareWorkDir, '.clwriting'), { recursive: true })
  makeBook(bareWorkDir, BRANCH_BOOK)
  bareServer = startServer({ port: 0, workDir: bareWorkDir })
  await new Promise<void>((r) => bareServer!.once('listening', r))
  bareBaseUrl = `http://127.0.0.1:${(bareServer.address() as AddressInfo).port}`
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (bareServer) await new Promise<void>((r) => bareServer!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
  if (bareWorkDir) rmSync(bareWorkDir, { recursive: true, force: true })
})

async function get(base: string, path: string): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${base}${path}`)
  return { status: r.status, json: await r.json().catch(() => null) }
}

interface BranchRow {
  branchId: string
  messageCount: number
  rootSeq: number
  lastSeq: number
  isDefault: boolean
  parentSeq: number | null
}

describe('G1 GET /api/books/:name/chat/branches', () => {
  it('多分支书：同 parentSeq 两组、最新组 isDefault、activeBranchId 指向最新组', async () => {
    const r = await get(baseUrl, `/api/books/${encodeURIComponent(BRANCH_BOOK)}/chat/branches`)
    expect(r.status).toBe(200)
    const j = r.json as { branches: BranchRow[]; activeBranchId: string | null }
    // listBranches 按组末 seq 降序（最新在前）；b1 组内两次生成 → messageCount 2
    expect(j.branches).toEqual([
      { branchId: 'b2', messageCount: 1, rootSeq: 4, lastSeq: 4, isDefault: true, parentSeq: 1 },
      { branchId: 'b1', messageCount: 2, rootSeq: 2, lastSeq: 3, isDefault: false, parentSeq: 1 },
    ])
    expect(j.activeBranchId).toBe('b2')
  })

  it('线性书（无分支元数据）→ 空分支列表、无默认分支', async () => {
    const r = await get(baseUrl, `/api/books/${encodeURIComponent(LINEAR_BOOK)}/chat/branches`)
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ branches: [], activeBranchId: null })
  })

  it('空书（有库无事件）→ 空分支列表、无默认分支', async () => {
    const r = await get(baseUrl, `/api/books/${encodeURIComponent(EMPTY_BOOK)}/chat/branches`)
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ branches: [], activeBranchId: null })
  })

  it('书名不存在 → 404 + 错误信封', async () => {
    const r = await get(baseUrl, `/api/books/${encodeURIComponent('不存在')}/chat/branches`)
    expect(r.status).toBe(404)
    expect((r.json as { error: string }).error).toContain('不存在')
  })
})

describe('G1 GET /api/books/:name/chat/history 分支视图', () => {
  it('缺省 ?branch= → 默认分支（最新组 b2 + 祖先链），不再堆叠各变体', async () => {
    const r = await get(baseUrl, `/api/books/${encodeURIComponent(BRANCH_BOOK)}/chat/history`)
    expect(r.status).toBe(200)
    const j = r.json as {
      messages: Array<{ role: string; content: unknown }>
      seqs: number[][]
      branchId: string | null
    }
    expect(j.branchId).toBe('b2')
    expect(j.messages).toEqual([
      { role: 'user', content: '第 3 章写得如何？' },
      { role: 'assistant', content: '新组回答：整体不错，结尾稍急。' },
    ])
    expect(j.seqs).toEqual([[1], [4]])
  })

  it('?branch=b1 → 旧组链（组内两条 + user 触发消息），不含其他变体', async () => {
    const r = await get(baseUrl, `/api/books/${encodeURIComponent(BRANCH_BOOK)}/chat/history?branch=b1`)
    expect(r.status).toBe(200)
    const j = r.json as {
      messages: Array<{ role: string; content: unknown }>
      seqs: number[][]
      branchId: string | null
    }
    expect(j.branchId).toBe('b1')
    expect(j.messages).toEqual([
      { role: 'user', content: '第 3 章写得如何？' },
      { role: 'assistant', content: '初版评价：节奏偏慢。' },
      { role: 'assistant', content: '同组第二次：钩子偏弱。' },
    ])
    expect(j.seqs).toEqual([[1], [2], [3]])
    expect(JSON.stringify(j.messages)).not.toContain('新组回答')
  })

  it('线性书：seqs 与 messages 平行（tool-result 合成消息多 seq）、消息一条不丢（旧书回归锚）', async () => {
    const r = await get(baseUrl, `/api/books/${encodeURIComponent(LINEAR_BOOK)}/chat/history`)
    expect(r.status).toBe(200)
    const j = r.json as {
      messages: Array<{ role: string; content: unknown }>
      seqs: number[][]
      branchId: string | null
    }
    // 无分支元数据 → 全量原样返回：5 条 surface 事件投影 4 条消息（两个 tool-result 合成一条）
    expect(j.messages).toHaveLength(4)
    expect(j.messages[0]).toEqual({ role: 'user', content: '帮我检查全书' })
    // 连续 tool-result 合成一条 user 消息 → seqs 对位为多 seq 数组 [3,4]
    expect(j.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'tu-1', content: '大纲全绿', isError: false },
        { type: 'tool_result', toolUseId: 'tu-2', content: '节奏两处偏慢', isError: false },
      ],
    })
    expect(j.messages[3]).toEqual({ role: 'assistant', content: '检查完毕：大纲没问题，节奏两处偏慢。' })
    expect(j.seqs).toEqual([[1], [2], [3, 4], [5]])
    expect(j.branchId).toBeNull()
  })
})

describe('G1 无 userDataPath（无事件库）→ 无分支，不报错', () => {
  it('branches → 200 + 空列表', async () => {
    const r = await get(bareBaseUrl, `/api/books/${encodeURIComponent(BRANCH_BOOK)}/chat/branches`)
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ branches: [], activeBranchId: null })
  })

  it('history → 200 + 空视图', async () => {
    const r = await get(bareBaseUrl, `/api/books/${encodeURIComponent(BRANCH_BOOK)}/chat/history`)
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ messages: [], seqs: [], branchId: null })
  })
})
