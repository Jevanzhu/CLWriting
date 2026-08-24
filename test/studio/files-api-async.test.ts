/**
 * S4（五十九轮）回归：files.ts 同步 IO 换 fs/promises。
 *
 * 原实现 readFileSync + hashFile 双份同步整读（PUT 乐观锁路径双份），数百 KB 设定
 * 文件阻塞事件循环秒级（SSE 心跳停摆）。修复：单次异步读取共源出 content + revision
 * （哈希口径与 fs/hash hashFile 同构）。本测试锚定行为契约不回归：
 * GET content/revision、PUT 乐观锁 409、PUT 成功回滚动基线 revision。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = '文件异步测试书'
const FILE_Q = encodeURIComponent('设定/总纲.md')
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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-files-async-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '设定'), { recursive: true })
  writeFileSync(join(bookRoot, '设定', '总纲.md'), '旧总纲内容')
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 文件异步测试书\n  genre: 玄幻\nhost: cc\n')
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

describe('S4: /file 端点异步化后行为契约不回归', () => {
  const path = `/api/books/${encodeURIComponent(BOOK)}/file?file=${FILE_Q}`

  it('GET → content + sha256 revision（与 hashFile 口径同构）', async () => {
    const r = await req('GET', path)
    expect(r.status).toBe(200)
    const j = r.json as { content: string; revision: string }
    expect(j.content).toBe('旧总纲内容')
    expect(j.revision).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('GET 不存在文件 → 404（异步 ENOENT 判定）', async () => {
    const r = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('设定/不存在.md')}`)
    expect(r.status).toBe(404)
  })

  it('PUT 基线不符 → 409 REVISION_CONFLICT（乐观锁不回归）', async () => {
    const r = await req('PUT', path, { content: 'x', expectedRevision: 'sha256:stale' })
    expect(r.status).toBe(409)
    expect((r.json as { code: string }).code).toBe('REVISION_CONFLICT')
  })

  it('PUT 成功 → 回新 revision = 写入内容指纹（滚动基线）', async () => {
    const got = await req('GET', path)
    const base = (got.json as { revision: string }).revision
    const r = await req('PUT', path, { content: '新总纲内容', expectedRevision: base })
    expect(r.status).toBe(200)
    const rev = (r.json as { revision: string }).revision
    expect(rev).toMatch(/^sha256:[0-9a-f]{64}$/)
    // 回读复核：盘上内容与 revision 自洽（异步读取无错位）
    const again = await req('GET', path)
    const j = again.json as { content: string; revision: string }
    expect(j.content).toBe('新总纲内容')
    expect(j.revision).toBe(rev)
  })
})
