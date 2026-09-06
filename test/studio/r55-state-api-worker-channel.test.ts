/**
 * R55-B-N（五十五轮）回归：HTTP 消费点走 detectState worker 通道的接线钉。
 *
 * /api/books/:name/state（api/state.ts）与 /api/books/:name/overview（api/overview.ts）
 * 必须以 { rebuildChannel: 'worker' } 调 detectState——大书 index.db 缺失/损坏首进门
 * 的全量 rebuild 卸到 worker 线程（R48-11 通道），服务进程事件循环不再被同步内核
 * 秒级冻结。手法：vi.mock state/state.js 委托（r37-overview-cache-async 先例同款）
 * + 真实 server，断言两端点传入 detectState 的第 4 参（opts）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/state/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/state.js')>()
  return { ...actual, detectState: vi.fn(actual.detectState) }
})

import { detectState } from '../../src/state/state.js'
import { forgetStateCache } from '../../src/studio/server/api/state.js'
import { forgetOverviewCache } from '../../src/studio/server/api/overview.js'
import { startServerSafe } from '../helpers/safe-port.js'

const detectStateMock = vi.mocked(detectState)

const BOOK = 'R55接线书' // 与 book.yaml title 一致——startServer 启动重扫书架按 title 派生名，错位会被覆写成查无此书
let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r55-wire-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n')
  bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nbook:\n  title: ${BOOK}\n  genre: 仙侠\nkind: long\nhost: cc\n`, 'utf-8')
  writeFileSync(join(bookRoot, '大纲', '总纲.md'), '# 总纲', 'utf-8')

  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { 'x-studio-token': token } })
}

describe('R55-B-N：HTTP 消费点走 detectState worker 通道', () => {
  it('GET /api/books/:name/state → detectState 第 4 参 { rebuildChannel: "worker" }', async () => {
    forgetStateCache(bookRoot) // R75-D-P3b TTL 缓存隔离（首请求必真实判态）
    const callsBefore = detectStateMock.mock.calls.length
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/state`)
    expect(r.status).toBe(200)
    expect(detectStateMock.mock.calls.length).toBe(callsBefore + 1)
    const call = detectStateMock.mock.calls[callsBefore]!
    expect(call[0]).toBe(bookRoot)
    expect(call[3]).toEqual({ rebuildChannel: 'worker' })
  })

  it('GET /api/books/:name/overview → 同口径第 4 参（manifest 缺省 undefined）', async () => {
    forgetOverviewCache(bookRoot) // G3/R47-7 缓存隔离
    const callsBefore = detectStateMock.mock.calls.length
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/overview`)
    expect(r.status).toBe(200)
    expect(detectStateMock.mock.calls.length).toBe(callsBefore + 1)
    const call = detectStateMock.mock.calls[callsBefore]!
    expect(call[0]).toBe(bookRoot)
    expect(call[2]).toBeUndefined()
    expect(call[3]).toEqual({ rebuildChannel: 'worker' })
  })
})
