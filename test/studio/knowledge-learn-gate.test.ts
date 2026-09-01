/**
 * R66-28（十四轮）回归：POST /learn 全书同步扫描的并发闸 + TTL 缓存。
 *
 * 缺陷：learnFromBook 同步整读全书定稿正文（请求线程阻塞秒级），端点既无并发闸
 * 也无缓存——重复点击双跑双扫（health/files/documents 同型已修，此处漏网）。
 * 修复：套 acquireTaskGate（learn）+ 成功结果按书 5s TTL 缓存（health.ts 口径）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, afterEach } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'
import { __setLearnTtlForTest } from '../../src/studio/server/api/knowledge.js'

const BOOK = '学习闸测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r66-28-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n')
  const bookRoot = join(workDir, BOOK)
  // 有定稿正文（无清单 → finalizedPathSet null → 全量收割，learnFromBook ok:true）
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, '写作', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场，初入宗门。\n',
    'utf-8',
  )
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 学习闸测试书\n  genre: 玄幻\nhost: cc\n')
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const boot = (await (await fetch(`${baseUrl}/api/boot`)).json()) as { token: string }
  token = boot.token
})

afterAll(async () => {
  __setLearnTtlForTest(null)
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

afterEach(() => {
  __setLearnTtlForTest(null)
})

describe('R66-28: /learn 并发闸', () => {
  it('learn 闸被持有 → 409；释放 → 非 409（走通收割）', async () => {
    const release = acquireTaskGate(BOOK, 'learn')
    expect(release).not.toBeNull()
    const busy = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/learn`)
    expect(busy.status).toBe(409)
    expect((busy.json as { error: string }).error).toContain('收割')
    release!()
    const ok = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/learn`)
    expect(ok.status).not.toBe(409)
    expect(ok.status).toBe(200)
  })
})

describe('R66-28: /learn TTL 缓存', () => {
  it('TTL 内重复请求命中缓存（正文删除后仍 200）；TTL 过期重扫（无正文 → 400）', async () => {
    // 注入短档 TTL：真实 5s 墙钟依赖会让「失效重扫」用例慢机假红（health.ts R62-21 口径）
    __setLearnTtlForTest(300)
    const first = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/learn`)
    expect(first.status).toBe(200)
    // 删掉全部正文：TTL 内第二次请求应命中缓存（不重扫 → 仍 200）
    rmSync(join(workDir, BOOK, '写作', '正文'), { recursive: true, force: true })
    const cached = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/learn`)
    expect(cached.status).toBe(200)
    // TTL 过期 → 重扫 → 无定稿正文 → 400（证明缓存确有失效路径，非永久缓存）
    await new Promise((r) => setTimeout(r, 400))
    const expired = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/learn`)
    expect(expired.status).toBe(400)
    expect((expired.json as { error?: string }).error).toMatch(/没有定稿正文/)
  })
})
