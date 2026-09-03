/**
 * R40-4（四十轮）回归：收割端点任务闸 + scanChaptersAsync 等价性。
 *
 * 缺陷一（闸）：POST /style/harvest 整树扫描 + 落盘候选箱却无并发闸——重复点击
 * 双跑双扫互踩查重闸口径（learn R66-28 同族漏网）。修复：acquireTaskGate
 * （'style-harvest'，已登记 KNOWN_ACTIONS）同款 409 BUSY。
 * 缺陷二（让出）：收割源2 与 health 缓存 miss 此前同步 scanChapters，200 万字
 * 大书秒级冻结事件循环（R39-15 同族漏网点）。修复：scanChaptersAsync 逐 25 章
 * 让出；等价性（与同步版逐字段一致）在此锚定。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'
import { scanChapters, scanChaptersAsync } from '../../src/metrics/style.js'

const BOOK = '收割闸测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function req(method: string, path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const r = http.request(
      { host: u.hostname, port: u.port, path, method, headers: { 'x-studio-token': token, origin: baseUrl } },
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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r40-harvest-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n')
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n\n主角登场。\n', 'utf-8')
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 收割闸测试书\n  genre: 玄幻\nhost: cc\n')
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const boot = (await (await fetch(`${baseUrl}/api/boot`)).json()) as { token: string }
  token = boot.token
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('R40-4: 收割端点任务闸', () => {
  it('闸被持有 → 409 BUSY；释放后 → 200', async () => {
    const bookPath = encodeURIComponent(BOOK)
    const release = acquireTaskGate(BOOK, 'style-harvest')
    expect(release).not.toBeNull()
    try {
      const r1 = await req('POST', `/api/books/${bookPath}/style/harvest`)
      expect(r1.status).toBe(409)
      expect(r1.json).toMatchObject({ code: 'BUSY' })
    } finally {
      release!()
    }
    const r2 = await req('POST', `/api/books/${bookPath}/style/harvest`)
    expect(r2.status).toBe(200)
    expect(r2.json).toMatchObject({ ok: true })
  })
})

describe('R40-4: scanChaptersAsync 与同步版等价', () => {
  it('同书逐字段一致（含章号/标题/指纹）', async () => {
    const bookRoot = join(workDir, BOOK)
    const sync = scanChapters(bookRoot)
    const asyncRes = await scanChaptersAsync(bookRoot)
    expect(asyncRes).toEqual(sync)
    expect(sync.length).toBeGreaterThan(0)
  })
})
