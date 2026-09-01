/**
 * S3（五十九轮）回归：export 端点并发闸。
 *
 * 双击并发 exportBook 互踩（rmSync 导出目录互删 → ENOENT 500）。修复：入口套
 * acquireTaskGate 同款同步占位 + finally 释放，并发第二请求 409。
 * S4 留档：export 内核（src/export/index.ts）仍为全同步 IO——先收并发面，
 * 全量异步化另行批次收口（files.ts 已改 fs/promises，见 files-api-async.test.ts）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'

const BOOK = '导出闸测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

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

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-export-gate-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  // 章节布局对齐 test/export/export.test.ts 的 makeLongBook/writeLongChapter
  // （写作/正文/<num>-<标题>.md + front matter——exportBook 的定稿扫描口径）
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 导出闸测试书\n  genre: 玄幻\nhost: cc\n')
  writeFileSync(join(bookRoot, '写作', '正文', '1-第一章.md'), '---\n章号: 1\n标题: 第一章\n---\n雪落在了城墙上。')
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('S3: export 端点并发闸（409 + 释放后可重试）', () => {
  const path = `/api/books/${encodeURIComponent(BOOK)}/export`

  it('闸被持有（并发第二请求）→ 409 BUSY', async () => {
    const release = acquireTaskGate(BOOK, 'export', { lockDir: null })
    expect(release).toBeTruthy()
    try {
      const r = await req('POST', path, { format: 'merged' })
      expect(r.status).toBe(409)
      expect((r.json as { code: string }).code).toBe('BUSY')
    } finally {
      release!()
    }
  })

  it('闸释放后 → 非 409（导出正常执行，业务失败编码在 body.ok）', async () => {
    const r = await req('POST', path, { format: 'merged' })
    expect(r.status).not.toBe(409)
    expect((r.json as { ok: boolean }).ok).toBe(true)
  })
})
