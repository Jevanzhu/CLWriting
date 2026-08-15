/**
 * lead-updates 端点集成测试（W-P1-3 右端）。
 *
 * mock 环境：POST /api/books/:name/lead-updates {chapter} → 200 + 账本推进.md 落盘。
 * 需要：长篇 + 布线 + 正文存在 + 进行中账本。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = '账本推进书'
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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-leadup-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-leadup-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '布线', '悬念'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 账本推进书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  writeFileSync(
    join(bookRoot, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  writeFileSync(
    join(bookRoot, '写作', '正文', '001-夜访.md'),
    '---\n章号: 1\n标题: 夜访\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的钟声在雨夜里连响了三下。\n',
    'utf-8',
  )
  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const r = await fetch(baseUrl + '/api/boot')
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('POST /lead-updates（账本推进生成）', () => {
  it('mock 环境 → 200 + 账本推进.md 落盘', async () => {
    process.env['CLWRITING_DRIVER'] = 'mock'
    const r = await req('POST', '/api/books/' + encodeURIComponent(BOOK) + '/lead-updates', { chapter: 1 })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; count: number; path: string }
    expect(body.ok).toBe(true)
    expect(body.path).toBe('工作区/账本推进.md')
    const bookRoot = join(workDir, BOOK)
    expect(existsSync(join(bookRoot, '工作区', '账本推进.md'))).toBe(true)
    // mock 产出含 悬念-001 递进（LEAD_UPDATE_SPEC.mock）→ 白名单命中 → count ≥ 1
    expect(body.count).toBeGreaterThanOrEqual(1)
  })

  it('正文不存在 → 404', async () => {
    const r = await req('POST', '/api/books/' + encodeURIComponent(BOOK) + '/lead-updates', { chapter: 99 })
    expect(r.status).toBe(404)
  })

  it('短篇无布线 → 400（防误用）', async () => {
    process.env['CLWRITING_DRIVER'] = 'mock'
    // 造一本短篇书并注册
    const shortName = '短篇书'
    const bookRoot = join(workDir, shortName)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: short\nbook:\n  title: 短篇书\nhost: cc\n', 'utf8')
    writeFileSync(
      join(workDir, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: shortName, path: shortName, kind: 'short' }) + '\n',
      { flag: 'a' },
    )
    const r = await req('POST', '/api/books/' + encodeURIComponent(shortName) + '/lead-updates', { chapter: 1 })
    expect(r.status).toBe(400)
  })
})