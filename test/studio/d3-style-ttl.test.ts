/**
 * D3（内存审计 2026-08-24）：health/style 与 analyze-style 全书扫描 5s TTL 缓存。
 * 口径对齐 overview.ts stateCache（书键 Map + FIFO + 纯 TTL，无写路径失效挂点）。
 * 验证（mock driver）：
 * - 命中：5s 内二次调用不重扫——盘上新增章/改正文对结果不可见
 *   （health/style count 不变、analyze-style envelope.sourceHash 不变）。
 * - 失效：TTL 到期后重扫——盘上变更可见（count 变化、sourceHash 变化）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { __setStyleScanTtlForTest } from '../../src/studio/server/api/health.js'
import { __setStyleCorpusTtlForTest } from '../../src/studio/server/api/analysis.js'

const BOOK = 'D3测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let cachedStyleHash = '' // it1 建缓存时 analyze-style 的采样正文 hash（it2 断言变化用）
const prevDriver = process.env['CLWRITING_DRIVER']

function req(method: string, path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: { 'x-studio-token': token },
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
    r.end()
  })
}

const CH1_FM = '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n'

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-d3-ttl-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  // 不建 项目/文档清单.jsonl——finalizedPathSet 返 null 走全量口径，章文件直接进扫描样本
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: D3测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), CH1_FM + '主角登场，初入宗门，一切由此开始。\n', 'utf8')

  // R62-21：两处 TTL 均注入短档——消除 STYLE_SCAN_TTL+300≈5.3s 真实墙钟，慢机假红。
  // R76-37（二十四轮 F 域）：300ms→1000ms——「命中」用例首查与二查之间夹着两次
  // writeFileSync，慢机/CI 卡顿下超 300ms 即缓存过期、二查变重扫（count/hash 变化），
  // 假红；1000ms 给足裕量，到期侧睡 TTL+500 不受影响。
  __setStyleScanTtlForTest(1000)
  __setStyleCorpusTtlForTest(1000)
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  __setStyleScanTtlForTest(null) // R62-21：恢复默认 TTL，避免污染同进程其它测试
  __setStyleCorpusTtlForTest(null)
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('D3：health/style + analyze-style 全书扫描 5s TTL 缓存', () => {
  it('命中：5s 内二次调用不重扫（盘上变更不可见）', async () => {
    // 建缓存：health（scanChapters 样本）+ analyze-style（采样正文/全文 stats）
    const first = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/health/style`)
    expect(first.status).toBe(200)
    expect((first.json as { count: number }).count).toBe(1)

    const styleFirst = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/analyze-style`)
    expect(styleFirst.status).toBe(200)
    cachedStyleHash = (styleFirst.json as { envelope: { sourceHash: string } }).envelope.sourceHash
    expect(cachedStyleHash).toMatch(/^[0-9a-f]{64}$/)

    // 盘上变更：新增章 0002 + 改写章 1 正文（重扫应能见到两者的口径）
    const bookRoot = join(workDir, BOOK)
    writeFileSync(
      join(bookRoot, '写作', '正文', '0002-次章.md'),
      '---\n章号: 2\n标题: 次章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第二章正文登场。\n',
      'utf8',
    )
    writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), CH1_FM + '主角登场，正文已被作者彻底改写一新。\n', 'utf8')

    // 5s 内二次调用：均命中缓存——count 不变（未见新章）、sourceHash 不变（未见改写正文）
    const second = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/health/style`)
    expect(second.status).toBe(200)
    expect((second.json as { count: number }).count).toBe(1)

    const styleSecond = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/analyze-style`)
    expect(styleSecond.status).toBe(200)
    expect((styleSecond.json as { envelope: { sourceHash: string } }).envelope.sourceHash).toBe(cachedStyleHash)
  })

  it('失效：TTL 到期后重扫（盘上变更可见）', async () => {
    // R62-21：注入 TTL（R76-37 起为 1000ms）→ 睡 TTL+500 过期（含余量）。此前
    // STYLE_SCAN_TTL+300≈5.3s 真实墙钟，慢机假红。
    await new Promise((r) => setTimeout(r, 1000 + 500))

    const third = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/health/style`)
    expect(third.status).toBe(200)
    expect((third.json as { count: number }).count).toBe(2) // 重扫见到新章 0002

    const styleThird = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/analyze-style`)
    expect(styleThird.status).toBe(200)
    const hash3 = (styleThird.json as { envelope: { sourceHash: string } }).envelope.sourceHash
    expect(hash3).toMatch(/^[0-9a-f]{64}$/)
    expect(hash3).not.toBe(cachedStyleHash) // 重扫见到改写正文 + 新章（采样正文 hash 变化）
  })
})
