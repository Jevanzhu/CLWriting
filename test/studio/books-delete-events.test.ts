/**
 * DELETE /api/books/:name 删书清事件库回归测（GG-P2-3）：
 * 事件库按 bookHash(bookRoot) 落在 userDataPath/clwriting/session/，
 * 与书仓库分离——此前删书只清内存对话态，同名重建书会打开同一个 .db
 * 并在 audit 重放里继承旧书会话/链路事件。修复：删书时 clearChatHistory
 * 双键清库（book=书名 + book=bookHash(bookRoot)，Y-P2-7 口径）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'

const BOOK = '删书事件测试书'
let workDir = ''
let userDataDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 响应留 null */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-del-events-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'clwriting-del-user-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: `长篇/${BOOK}`, kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }) + '\n',
    'utf-8',
  )
  writeFileSync(join(workDir, '.clwriting', 'active'), BOOK + '\n', 'utf-8')
  const bookAbs = join(workDir, '长篇', BOOK)
  mkdirSync(join(bookAbs, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookAbs, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK}\n  genre: 玄幻\nhost: cc\n`, 'utf-8')

  // 播种旧书事件：对话会话（book=书名）+ 工作区会话（book=bookHash，ws- 前缀口径）
  const store = openSessionStore(userDataDir, bookAbs)
  const chatSid = store!.createSession(BOOK)
  store!.appendEvents(chatSid, [{ type: 'session/start', data: { reason: 'chat' } }])
  const wsSid = store!.createSession(bookHash(bookAbs))
  store!.appendEvents(wsSid, [{ type: 'session/start', data: { reason: 'workspace' } }])
  store!.close()

  server = startServer({ port: 0, workDir, userDataPath: userDataDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

describe('DELETE /api/books/:name 清事件库（GG-P2-3）', () => {
  it('删书后同名重建：事件库为空，不继承旧书会话', async () => {
    const bookAbs = join(workDir, '长篇', BOOK)
    // 删前：两种会话都在
    const before = openSessionStore(userDataDir, bookAbs)
    expect(before!.lastSeq()).toBeGreaterThan(0)
    before!.close()

    const del = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}`)
    expect(del.status).toBe(200)

    // 删后：同一 bookRoot 的 .db 双键全清（lastSeq 归零）——同名重建即拿到空库
    const after = openSessionStore(userDataDir, bookAbs)
    expect(after!.lastSeq()).toBe(0)
    after!.close()
  })
})
