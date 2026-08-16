/**
 * RB-SV-P2-2 回归：长任务并发闸。
 *
 * - acquireTaskGate 单元语义：首占成功 / 重复占返回 null / release 幂等 / 释放后可再占 /
 *   book 或 action 不同互不阻塞
 * - 端点接线：闸被持有时 relations/mine 与 outline 回 409；释放后 outline 走通（mock）
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { acquireTaskGate, isTaskGateHeld } from '../../src/studio/server/api/task-gate.js'

const BOOK = '闸测试书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const prevDriver = process.env['CLWRITING_DRIVER']

function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body ? JSON.stringify(body) : ''
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': token,
          origin: baseUrl,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-gate-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-gate-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n')
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 闸测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n')
  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('acquireTaskGate 单元语义', () => {
  it('首占成功 → 重复占 null → 释放后可再占', () => {
    const release = acquireTaskGate('单元书', 'unit-action')
    expect(release).not.toBeNull()
    expect(isTaskGateHeld('单元书', 'unit-action')).toBe(true)
    expect(acquireTaskGate('单元书', 'unit-action')).toBeNull()
    release!()
    expect(isTaskGateHeld('单元书', 'unit-action')).toBe(false)
    const again = acquireTaskGate('单元书', 'unit-action')
    expect(again).not.toBeNull()
    again!()
  })

  it('release 幂等（多次调用不误删后占的闸）', () => {
    const r1 = acquireTaskGate('幂等书', 'idem-action')
    r1!()
    r1!() // 第二次重复释放应为 no-op
    const r2 = acquireTaskGate('幂等书', 'idem-action')
    expect(r2).not.toBeNull()
    r2!()
  })

  it('book 或 action 不同互不阻塞', () => {
    const ra = acquireTaskGate('书A', 'act')
    const rb = acquireTaskGate('书B', 'act')
    const rc = acquireTaskGate('书A', 'other-act')
    expect(ra && rb && rc).toBeTruthy()
    ra!()
    rb!()
    rc!()
  })
})

describe('端点并发闸接线（409）', () => {
  it('relations/mine 闸被持有 → 409；释放 → 非 409', async () => {
    const release = acquireTaskGate(BOOK, 'relations-mine')
    expect(release).not.toBeNull()
    const busy = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/relations/mine`, { force: true })
    expect(busy.status).toBe(409)
    expect((busy.json as { error: string }).error).toContain('梳理')
    release!()
    // 释放后进 handler（无梳理材料 → 400，证明过了闸）
    const ok = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/relations/mine`, { force: true })
    expect(ok.status).not.toBe(409)
  })

  it('outline 闸被持有 → 409；释放 → mock 走通 200', async () => {
    const release = acquireTaskGate(BOOK, 'outline')
    expect(release).not.toBeNull()
    const busy = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 1 })
    expect(busy.status).toBe(409)
    release!()
    const ok = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 1 })
    expect(ok.status).toBe(200)
    expect((ok.json as { ok: boolean }).ok).toBe(true)
  })
})
