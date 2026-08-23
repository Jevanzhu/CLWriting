/**
 * R-18（第十六轮）回归：删书 / 清空对话清理 per-book SSE 计数。
 *
 * sseConnections 只在 req close 时递减——删书/清空对话成功路径此前不清理，
 * 残留计数会让同名重建书被旧计数顶到 MAX_SSE_PER_BOOK(5) 的 429 上限。
 * 修复：stream.ts 导出 forgetSseCount(bookName)，books.delete 与 chat.clear 成功
 * 路径接线；本测试经 __getSseConnections 观测钩子断言。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { __getSseConnections } from '../../src/studio/server/api/stream.js'

const BOOK = 'SSE计数清理书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const openStreams: AbortController[] = []

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      origin: baseUrl,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 留 null */
  }
  return { status: r.status, json }
}

/** 打开一条 SSE 订阅（保持连接，收尾统一 abort）。 */
async function openStream(name: string): Promise<void> {
  const ac = new AbortController()
  openStreams.push(ac)
  const r = await fetch(
    `${baseUrl}/api/books/${encodeURIComponent(name)}/stream?token=${encodeURIComponent(token)}`,
    { signal: ac.signal },
  )
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toContain('text/event-stream')
  // 挂后台消费，防背压缓冲占满（只要连接活着即可）
  void r.body?.getReader().read().catch(() => { /* abort 后抛错忽略 */ })
}

/** 等计数稳定（连接建立→计数递增是即时的，给一拍事件循环余量）。 */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50))
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-sse-count-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: SSE计数清理书\n  genre: 玄幻\nhost: cc\n',
  )
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  for (const ac of openStreams) ac.abort()
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R-18: per-book SSE 计数随书级生命周期清理', () => {
  it('清空对话成功 → 计数清零（残留计数会顶 429 上限）', async () => {
    await openStream(BOOK)
    await openStream(BOOK)
    await tick()
    expect(__getSseConnections().get(BOOK)).toBe(2) // 连接在途：计数为 2
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/chat/clear`)
    expect(r.status).toBe(200)
    expect(__getSseConnections().has(BOOK)).toBe(false) // R-18：立即清，不等连接散场
  })

  it('删书成功 → 计数清零', async () => {
    await openStream(BOOK)
    await tick()
    expect(__getSseConnections().get(BOOK)).toBe(1)
    const r = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}`)
    expect(r.status).toBe(200)
    expect(__getSseConnections().has(BOOK)).toBe(false) // R-18：同名重建书不被旧计数顶上限
  })
})
