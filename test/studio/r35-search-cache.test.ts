/**
 * R35-7（三十五轮）回归：全书搜索端点缓存 + 在途去重（async 化不回退）。
 *
 * 此前 handler 同步调 searchBook——单书数千章查询期间冻结全进程（含 SSE 心跳）。
 * 修复后 handler 走 searchBookCached（目录 mtime 探针 + TTL 缓存 + 同参数并发去重 +
 * 底层 fs.promises 异步扫描）。本文件验证：
 * - 并发同参数只跑一次底层扫描；
 * - TTL 内重复查询命中不重扫；目录结构变化（新增文件）即时失效重扫（V-P2-25
 *   「写完即搜可见」契约）；forgetSearchCache/TTL 到期同样重扫；
 * - 空查询零成本不占缓存；
 * - HTTP 端点结果正确性不回退。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import {
  searchBookCached,
  forgetSearchCache,
  __setSearchCacheTtlForTest,
  __searchScanCountForTest,
  __resetSearchScanCountForTest,
} from '../../src/studio/server/api/search.js'

let root = ''

function makeTree(): string {
  root = mkdtempSync(join(tmpdir(), 'r35-search-cache-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '0001-雨夜.md'), '烛火摇曳。\n', 'utf-8')
  return root
}

afterEach(() => {
  __setSearchCacheTtlForTest(null)
  __resetSearchScanCountForTest()
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('R35-7 searchBookCached 缓存与去重', () => {
  it('并发同参数只跑一次底层扫描，全部调用拿到同结果', async () => {
    makeTree()
    const outs = await Promise.all(Array.from({ length: 8 }, () => searchBookCached(root, '烛火')))
    expect(__searchScanCountForTest()).toBe(1)
    for (const o of outs) expect(o).toEqual(outs[0])
    expect(outs[0]!.results).toHaveLength(1)
  })

  it('TTL 内重复查询命中；目录结构变化（新增文件）即时失效重扫；forgetSearchCache 同效', async () => {
    makeTree()
    __setSearchCacheTtlForTest(60_000) // 长档：慢机下也不会自然过期
    const first = await searchBookCached(root, '烛火')
    expect(__searchScanCountForTest()).toBe(1)
    const second = await searchBookCached(root, '烛火')
    expect(__searchScanCountForTest()).toBe(1) // 无写入：TTL 内命中，未重扫
    expect(second).toEqual(first)
    // V-P2-25 契约：直写盘的新文件（目录 mtime 变化）下一次搜索立即可见
    writeFileSync(join(root, '写作', '正文', '0002-晨光.md'), '烛火熄了。\n', 'utf-8')
    const third = await searchBookCached(root, '烛火')
    expect(__searchScanCountForTest()).toBe(2)
    expect(third.results.map((h) => h.path)).toContain('写作/正文/0002-晨光.md')
    forgetSearchCache(root) // 删书/改名挂点同款失效
    await searchBookCached(root, '烛火')
    expect(__searchScanCountForTest()).toBe(3)
  })

  it('TTL 到期重扫：盘上变更可见', async () => {
    makeTree()
    __setSearchCacheTtlForTest(0) // 即刻过期
    await searchBookCached(root, '烛火')
    writeFileSync(join(root, '写作', '正文', '0002-晨光.md'), '烛火熄了。\n', 'utf-8')
    const r = await searchBookCached(root, '烛火')
    expect(__searchScanCountForTest()).toBe(2)
    expect(r.results).toHaveLength(2)
  })

  it('不同参数（query/scope）各跑各的扫描；空查询零成本不占扫描', async () => {
    makeTree()
    await searchBookCached(root, '烛火')
    await searchBookCached(root, '烛火', '正文')
    await searchBookCached(root, '熄了')
    expect(__searchScanCountForTest()).toBe(3)
    const empty = await searchBookCached(root, '')
    expect(empty.results).toEqual([])
    expect(__searchScanCountForTest()).toBe(3)
  })
})

// ── HTTP 端点正确性不回退（handler 换 async + 缓存壳） ──────────────────────────
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let httpWorkDir = ''

function httpGet(path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const u = new URL(baseUrl)
    const req = http.request({ host: u.hostname, port: u.port, path, method: 'GET', headers: { 'x-studio-token': token } }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c.toString('utf8')))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }))
    })
    req.on('error', () => resolve({ status: 0, text: '' }))
    req.end()
  })
}

beforeAll(async () => {
  httpWorkDir = mkdtempSync(join(tmpdir(), 'r35-search-cache-http-'))
  const bookRoot = join(httpWorkDir, '缓存书')
  mkdirSync(join(httpWorkDir, '.clwriting'), { recursive: true })
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(httpWorkDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: '缓存书', path: '缓存书', kind: 'long' }) + '\n', 'utf-8')
  writeFileSync(join(bookRoot, 'book.yaml'), '标题: 缓存书\n', 'utf-8')
  writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), '山门外玉佩轻响。', 'utf-8')
  server = startServer({ workDir: httpWorkDir, port: 0, userDataPath: null })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await httpGet('/api/boot')
  token = ((JSON.parse(boot.text) as { token?: string }).token) ?? ''
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (httpWorkDir) rmSync(httpWorkDir, { recursive: true, force: true })
})

describe('R35-7 搜索端点 HTTP 正确性', () => {
  it('GET /search?q= 命中行不回退；连续两次查询结果一致（缓存壳透明）', async () => {
    const path = `/api/books/${encodeURIComponent('缓存书')}/search?q=${encodeURIComponent('玉佩')}`
    const r1 = await httpGet(path)
    expect(r1.status).toBe(200)
    const r2 = await httpGet(path)
    expect(r2.status).toBe(200)
    expect(r2.text).toBe(r1.text)
    const body = JSON.parse(r1.text) as { results: Array<{ path: string; matches: Array<{ line: number; text: string }> }> }
    expect(body.results).toHaveLength(1)
    expect(body.results[0]!.path).toBe('写作/正文/0001-开篇.md')
    expect(body.results[0]!.matches.length).toBeGreaterThan(0)
  })
})
