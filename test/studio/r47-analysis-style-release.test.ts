/**
 * R47-22（四十七轮）回归：analyze-style MISS 路径的双份整书正文驻留释放
 *（allBodies/recentBodies 在 join 产物算出后立即 length=0 清空）。
 *
 * 释放不可直接断言（模块内局部量），测行为回归：MISS 重扫（清空后数组不再被引用）
 * 必须仍产出正确 stats/采样——盘上改章 + 新增章后 TTL 到期重扫 sourceHash 变化；
 * TTL 内二查命中缓存（R62-21 注入口压短档）sourceHash 不变。造法沿用 d3-style-ttl。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { __setStyleCorpusTtlForTest } from '../../src/studio/server/api/analysis.js'

const BOOK = 'R47释放测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
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
        res.on('data', (c) => (data += c.toString('utf8')))
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

const CH_FM = (n: number, t: string) => `---\n章号: ${n}\n标题: ${t}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n`

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clw-r47-release-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK}\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n`)
  writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), CH_FM(1, '开篇') + '主角登场，初入宗门，一切由此开始。\n')
  // TTL 注入短档（R62-21/R76-37 口径：1000ms 档）。R0911-G-P1-1c（2026-09-11
  // 修复批）：到期臂改注入时钟推进 TTL+1（先例 r47-rebuild-probe-ttl 的 3001=3000+1
  // 同款），不再睡 TTL+500=1.5s 真实墙钟（CI 慢机测试段被睡眠拖长，macos 腿红族）；
  // 只接管 Date（TTL 判定读 Date.now()），setTimeout/HTTP 服务器/真实 I/O 照常真实
  //（toFake 选择性 fake 先例 p37-write-stall-watchdog）。
  vi.useFakeTimers({ toFake: ['Date'] })
  __setStyleCorpusTtlForTest(1000)
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  vi.useRealTimers() // R0911-G-P1-1c：解除 Date fake，避免污染同进程后续时序
  __setStyleCorpusTtlForTest(null)
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('R47-22：analyze-style MISS 路径行为回归（释放后重扫/缓存均正常）', () => {
  it('MISS 全书重扫 → 信封/候选正常；TTL 内二查命中缓存（sourceHash 不变）', async () => {
    const first = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/analyze-style`)
    expect(first.status).toBe(200)
    const j = first.json as { envelope: { sourceHash: string }; styleCandidates: number }
    expect(j.envelope.sourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof j.styleCandidates).toBe('number')

    // TTL 内二查：命中 styleCorpusCache（MISS 路径算出的缓存条目可复用）
    const second = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/analyze-style`)
    expect(second.status).toBe(200)
    const j2 = second.json as { envelope: { sourceHash: string } }
    expect(j2.envelope.sourceHash).toBe(j.envelope.sourceHash)
  })

  it('TTL 到期重扫：盘上改章 + 新增章可见（清空数组不影响重扫正确性）', async () => {
    const before = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/analyze-style`)
    expect(before.status).toBe(200)
    const hashBefore = (before.json as { envelope: { sourceHash: string } }).envelope.sourceHash

    const bookRoot = join(workDir, BOOK)
    writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), CH_FM(1, '开篇') + '主角登场，正文已被作者彻底改写一新。\n')
    writeFileSync(join(bookRoot, '写作', '正文', '0002-次章.md'), CH_FM(2, '次章') + '第二章正文登场，剧情推进。\n')

    // R0911-G-P1-1c：注入时钟推进 TTL+1 过期，不再睡 TTL+500 真实墙钟
    vi.advanceTimersByTime(1000 + 1)
    const after = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/analyze-style`)
    expect(after.status).toBe(200)
    const hashAfter = (after.json as { envelope: { sourceHash: string } }).envelope.sourceHash
    expect(hashAfter).toMatch(/^[0-9a-f]{64}$/)
    expect(hashAfter).not.toBe(hashBefore) // MISS 重扫见到改写 + 新章（采样正文变化）
  })
})
