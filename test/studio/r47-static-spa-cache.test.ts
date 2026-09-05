/**
 * R47-21（四十七轮）回归：SPA fallback 的 index.html 进程内单槽短缓存（TTL 5000ms）。
 *
 * 修复前每个 fallback 请求都 readFile 整读入口页；修复后 TTL 内命中直接回缓存
 * Buffer（零读盘，readFile 计数不增），过期/首读刷新读盘。staleness 契约：TTL 窗内
 * 盘上重建入口页 ≤5s 后可见（本测用 Date.now spy 推进时间，免真实 5s 墙钟）。
 * 响应头与 HEAD 分支逐字保持（nosniff / no-cache / content-length / 不发 body）。
 * 槽按入口绝对路径比对：不同 rootDir 实例（多窗口/测试间）不串页。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createStaticHandler } from '../../src/studio/server/static.js'

// 透传式 spy（先例 static.test.ts M-P3-09）——只计数不改行为，断言 SPA fallback 命中缓存时不再读盘
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
const readFileMock = vi.mocked(readFile)

let root = ''
let server: http.Server | undefined
let baseUrl = ''

// R47-21：可控时钟——handler 的 TTL 判定读 Date.now，spy 推进免真实 5s 墙钟
let fakeNow = 1_700_000_000_000
beforeEach(() => {
  fakeNow = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

async function serve(r: string): Promise<void> {
  server = http.createServer(createStaticHandler(r))
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** 统计 SPA fallback 对入口页的整读次数（排除其它路径的 readFile）。 */
function indexReads(): number {
  return readFileMock.mock.calls.filter((a) => String(a[0]).endsWith('index.html')).length
}

test('R47-21: 首读落缓存 → TTL 内命中零读盘 → 盘上重建 ≤TTL 不可见 / TTL 过期重读可见', async () => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-r47-spa-'))
  const V1 = '<!doctype html><title>Studio-v1</title>'
  writeFileSync(join(root, 'index.html'), V1)

  await serve(root)

  // 首读：SPA fallback 整读入口页一次，body 为 V1
  readFileMock.mockClear()
  const first = await fetch(`${baseUrl}/some/deep/route`)
  expect(first.status).toBe(200)
  expect(await first.text()).toBe(V1)
  expect(indexReads()).toBe(1)

  // TTL 内二查：命中缓存 Buffer——零读盘，同实例复用
  fakeNow += 1000
  const second = await fetch(`${baseUrl}/another/route`)
  expect(second.status).toBe(200)
  expect(await second.text()).toBe(V1)
  expect(indexReads()).toBe(1) // 未再读盘

  // TTL 内盘上重建（dev build）→ 仍回缓存 V1（staleness ≤5s 契约，注释已记档）
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Studio-v2</title>')
  fakeNow += 1000
  const stale = await fetch(`${baseUrl}/third/route`)
  expect(await stale.text()).toBe(V1)
  expect(indexReads()).toBe(1)

  // TTL 过期 → 重新读盘，V2 可见
  fakeNow += 5001
  const fresh = await fetch(`${baseUrl}/fourth/route`)
  expect(fresh.status).toBe(200)
  expect(await fresh.text()).toContain('Studio-v2')
  expect(indexReads()).toBe(2)
})

test('R47-21: HEAD fallback 走缓存同口径——响应头逐字保持、不发 body', async () => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-r47-spa-'))
  const V = '<!doctype html><title>Studio-head</title>'
  writeFileSync(join(root, 'index.html'), V)
  await serve(root)

  const head = await fetch(`${baseUrl}/missing-route`, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(head.headers.get('x-content-type-options')).toBe('nosniff')
  expect(head.headers.get('cache-control')).toBe('no-cache')
  expect(Number(head.headers.get('content-length'))).toBe(Buffer.byteLength(V))
  expect(await head.text()).toBe('')

  // TTL 内二查（GET）零读盘——HEAD 首查已落缓存，两分支共享同一槽
  readFileMock.mockClear()
  fakeNow += 1000
  const get = await fetch(`${baseUrl}/missing-route`)
  expect(await get.text()).toBe(V)
  expect(indexReads()).toBe(0)
})

test('R47-21: 槽按入口路径比对——不同 rootDir 实例不串页', async () => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-r47-spa-a'))
  const rootB = mkdtempSync(join(tmpdir(), 'clwriting-r47-spa-b'))
  try {
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>A</title>')
    writeFileSync(join(rootB, 'index.html'), '<!doctype html><title>B</title>')
    await serve(root)
    const a = await fetch(`${baseUrl}/route`)
    expect(await a.text()).toContain('<title>A</title>')

    // 同进程第二个实例（不同 dist root）：不得命中 A 的缓存槽
    const serverB = http.createServer(createStaticHandler(rootB))
    await new Promise<void>((resolve) => serverB.listen(0, '127.0.0.1', resolve))
    try {
      const baseB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`
      const b = await fetch(`${baseB}/route`)
      expect(await b.text()).toContain('<title>B</title>')
    } finally {
      await new Promise<void>((resolve) => serverB.close(() => resolve()))
    }
  } finally {
    rmSync(rootB, { recursive: true, force: true })
  }
})

test('R47-21: 入口页缺失 → 404 信封不变（读失败不回填缓存）', async () => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-r47-spa-empty'))
  await serve(root)
  const res = await fetch(`${baseUrl}/spa-route`)
  expect(res.status).toBe(404)
  expect(JSON.parse(await res.text())).toEqual({
    code: 'NOT_FOUND',
    error: '前端尚未构建。请先运行：npm --prefix src/studio/web-next run build',
  })
})
