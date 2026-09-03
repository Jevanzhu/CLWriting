/**
 * R42-16（四十二轮）回归：analyze-style 的 styleCorpusCache.set 记 set 当刻 ts。
 *
 * 修复前 ts 记「扫描前取的 now」——MISS 分支读循环含逐块让出（每 25 章一次
 * setImmediate），大书扫描跨数百 ms 时缓存「出生即折旧」，TTL 窗被扫描时长吃掉，
 * 极端时刚 set 完就已过期（二查必 MISS 重扫）。
 *
 * 时序构造（确定性，不赌真实墙钟的扫描快慢）：
 * - vi.mock 放慢 progress.yieldToEventLoop（唯一调用点即本扫描段，在 now 与 set 之间
 *   被 await）——扫描段确定性耗掉 SCAN_DELAY_MS（> TTL）；
 * - 注入 TTL（__setStyleCorpusTtlForTest）：req1（慢扫描 MISS）后立即 req2——修复后
 *   ts=set 当刻 → 命中（盘上已改文对 sourceHash 不可见）；修复前 ts=扫描前 now →
 *   TTL 已被吃光 → MISS 重扫（sourceHash 变化，红）；
 * - req3 睡过 TTL 后重扫见到改文——反证 req2 的 hash 不变来自缓存命中而非扫描失明。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { __setStyleCorpusTtlForTest } from '../../src/studio/server/api/analysis.js'

const mockState = vi.hoisted(() => ({ yieldDelayMs: 0 }))

// 仅放慢逐块让出原语（delay=0 时原样透传，不影响其它导出与其它端点行为）
vi.mock('../../src/studio/server/api/progress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/studio/server/api/progress.js')>()
  return {
    ...actual,
    yieldToEventLoop: () =>
      mockState.yieldDelayMs > 0
        ? new Promise<void>((resolve) => setTimeout(resolve, mockState.yieldDelayMs))
        : actual.yieldToEventLoop(),
  }
})

const BOOK = 'R42语料书'
const CHAPTERS = 25 // 恰过 SCAN_YIELD_EVERY（25）一次让出
const TTL_MS = 700
const SCAN_DELAY_MS = 1800
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const prevDriver = process.env['CLWRITING_DRIVER']

function chapterFm(n: number): string {
  return `---\n章号: ${n}\n标题: 第${n}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n`
}

function chapterFile(n: number): string {
  return `${String(n).padStart(4, '0')}-第${n}章.md`
}

function req(method: string, path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const r = http.request(
      { host: u.hostname, port: u.port, path, method, headers: { 'x-studio-token': token } },
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

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clw-r42-style-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: R42语料书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  for (let n = 1; n <= CHAPTERS; n++) {
    writeFileSync(join(bookRoot, '写作', '正文', chapterFile(n)), chapterFm(n) + `第${n}章原始正文，主角稳步推进。\n`, 'utf8')
  }
  __setStyleCorpusTtlForTest(TTL_MS)
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  __setStyleCorpusTtlForTest(null)
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

it('R42-16: 慢扫描（让出段 > TTL）后立即二查命中缓存——ts 记 set 当刻而非扫描前', async () => {
  // req1：MISS 慢扫描（唯一让出点确定性睡 SCAN_DELAY_MS——落在扫描前 now 与 set 之间）
  mockState.yieldDelayMs = SCAN_DELAY_MS
  let hash1 = ''
  try {
    const r1 = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/analyze-style`)
    expect(r1.status).toBe(200)
    hash1 = (r1.json as { envelope: { sourceHash: string } }).envelope.sourceHash
    expect(hash1).toMatch(/^[0-9a-f]{64}$/)
  } finally {
    mockState.yieldDelayMs = 0
  }

  // 盘上改写第 25 章（在最近 10 章采样集内）——MISS 重扫时 sourceHash 必变
  writeFileSync(
    join(workDir, BOOK, '写作', '正文', chapterFile(CHAPTERS)),
    chapterFm(CHAPTERS) + '作者已彻底改写的全新正文，与原稿一字不差地不同。\n',
    'utf8',
  )

  // 立即二查：修复后 ts=set 当刻（约 req1 收尾时刻）→ 未过期 → 命中缓存，
  // sourceHash 仍旧值；修复前 ts=扫描前 now（早 SCAN_DELAY_MS）→ MISS 重扫见新文
  const r2 = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/analyze-style`)
  expect(r2.status).toBe(200)
  expect((r2.json as { envelope: { sourceHash: string } }).envelope.sourceHash).toBe(hash1)

  // 反证：真过期（睡 TTL+裕量）后重扫见到改文——排除「扫描失明」假绿
  await new Promise((r) => setTimeout(r, TTL_MS + 400))
  const r3 = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/analyze-style`)
  expect(r3.status).toBe(200)
  expect((r3.json as { envelope: { sourceHash: string } }).envelope.sourceHash).not.toBe(hash1)
})
