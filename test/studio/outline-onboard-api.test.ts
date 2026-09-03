/**
 * outline / onboard 端点集成测试（评审 §六测试盲区：outline/onboard 端点零 spec）。
 *
 * 核心回归：P0-1 mockText 守卫——非 mock 环境 mockText 不短路，
 * 端点走 resolveProvider（无 provider → 500 NO_PROVIDER），而非返回 mock 文本。
 *
 * mock 环境：验证 mock 快路正常返回 + 落盘。
 * 非 mock 环境：验证 mockText 守卫生效（不走 mock 快路）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

const BOOK = '大纲测试书'
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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-outline-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-outline-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 大纲测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  server = await startServerSafe({ port: 0, workDir, userDataPath })
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

describe('POST /outline（大纲生成）', () => {
  it('mock 环境 → 200 + mock 文本落盘', async () => {
    process.env['CLWRITING_DRIVER'] = 'mock'
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 1 })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; words: number; path: string }
    expect(body.ok).toBe(true)
    expect(body.words).toBeGreaterThan(0)
    // 落盘验证（细纲路径：工作区/细纲.md）
    const bookRoot = join(workDir, BOOK)
    expect(existsSync(join(bookRoot, '工作区', '细纲.md'))).toBe(true)
  })

  it('outline 非 mock + 无 provider → 400 NO_PROVIDER（mockText 不短路，P0-1 回归；R43-24 code 映射）', async () => {
    delete process.env['CLWRITING_DRIVER']
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 1 })
    // R43-24（四十三轮）：outline 失败封套透传 TaskCode——NO_PROVIDER 族由 500 GEN_FAIL
    // 改映射 400（配置缺失是客户端可处置），文案不变；P0-1 回归语义仍在（非 mock
    // 不走 mockText 短路，真实走到 provider 解析失败）
    expect(r.status).toBe(400)
    const j = r.json as { code: string; error: string }
    expect(j.code).toBe('NO_PROVIDER')
    expect(j.error).toContain('未配置')
    // 恢复 mock 环境
    process.env['CLWRITING_DRIVER'] = 'mock'
  })
})

describe('POST /onboard-ai（开书引导）', () => {
  it('mock 环境 → 200 + mock 设定落盘', async () => {
    process.env['CLWRITING_DRIVER'] = 'mock'
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, { step: 'synopsis' })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; words: number; step: string; path: string }
    expect(body.ok).toBe(true)
    expect(body.step).toBe('synopsis')
    expect(body.words).toBeGreaterThan(0)
    // 落盘验证
    const bookRoot = join(workDir, BOOK)
    expect(existsSync(join(bookRoot, '大纲', '总纲.md'))).toBe(true)
  })

  it('onboard-ai 非 mock + 无 provider → 500（mockText 不短路，P0-1 回归）', async () => {
    delete process.env['CLWRITING_DRIVER']
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, { step: 'characters' })
    expect(r.status).toBe(500)
    expect((r.json as { error: string }).error).toContain('未配置')
    // 恢复 mock 环境
    process.env['CLWRITING_DRIVER'] = 'mock'
  })
})
