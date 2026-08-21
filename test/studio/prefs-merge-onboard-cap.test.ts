/**
 * 低级项（第六轮）回归：
 * - 书级 PUT /api/books/:name/prefs 合并写（对齐 library 级第五轮口径）——payload 之外
 *   的盘上键在 PUT 后存活，不再被整体覆写静默清键
 * - POST /api/books/:name/onboard-ai 自由文本长度上限——premise/discussionContext
 *   超 5 万字符 → 400（打不进 prompt）
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = '合并偏好书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function req<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': token,
          ...(body !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) }
            : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json = null as T
          try {
            json = JSON.parse(data) as T
          } catch {
            /* 非 JSON 体 */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (body !== undefined) r.write(JSON.stringify(body))
    r.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-prefs-merge-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 合并偏好书\n  genre: 玄幻\nhost: cc\n')

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('低级项（第六轮）：书级 prefs 合并写', () => {
  it('PUT 后 payload 之外的盘上键存活（修复前：整体覆写清键）', async () => {
    const prefsPath = join(workDir, BOOK, '.clwriting', 'prefs.json')
    mkdirSync(join(workDir, BOOK, '.clwriting'), { recursive: true })
    // 盘上先有一个端点 payload 之外的键（脚本/手工写入）
    writeFileSync(prefsPath, JSON.stringify({ customScriptKey: 'keep-me', leftWidth: 220 }, null, 2), 'utf8')

    // 前端只回传自己已知的键
    const w = await req<{ ok: boolean }>(
      'PUT',
      `/api/books/${encodeURIComponent(BOOK)}/prefs`,
      { prefs: { leftWidth: 260, leftOpen: true } },
    )
    expect(w.status).toBe(200)
    expect(w.json.ok).toBe(true)

    const after = JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>
    expect(after['customScriptKey']).toBe('keep-me') // 修复前：被覆写丢失
    expect(after['leftWidth']).toBe(260) // 同名键客户端覆盖
    expect(after['leftOpen']).toBe(true) // 新键写入
  })
})

describe('低级项（第六轮）：onboard-ai 自由文本长度上限', () => {
  it('premise 超 5 万字符 → 400，不进 prompt', async () => {
    const r = await req<{ error: string }>(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`,
      { step: 'synopsis', premise: 'x'.repeat(50_001) },
    )
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('过长')
  })

  it('discussionContext 超限同口径 400；正常长度不受影响（走 step 校验，不到 AI）', async () => {
    const r = await req<{ error: string }>(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`,
      { step: 'synopsis', discussionContext: 'y'.repeat(50_001) },
    )
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('过长')

    // 正常长度自由文本 + 非法 step：长度闸放行、命中 step 校验（证明上限不打扰正常路径）
    const ok = await req<{ error: string }>(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`,
      { step: 'bad-step', premise: '一个正常的梗概' },
    )
    expect(ok.status).toBe(400)
    expect(ok.json.error).toContain('step 不支持')
  })
})
