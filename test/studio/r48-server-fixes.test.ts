/**
 * R48（四十八轮）批 11（studio/server）修复回归：
 * - R48-19：伏笔端点 handler 改 async 调 getForeshadowsCachedAsync（PM-1 只交付了
 *   函数、handler 未随迁的失实收口随批纠正）——HTTP 层锚定端点经异步路径正常回包。
 * - R48-20：onboard-save 空 content → 400 BAD_INPUT（此前静默清空设定文件假成功，
 *   对齐 draft.ts 先例）。
 * - R48-77：关系梳理结果（mock 快路非空产出）落缓存后二次请求 cached:true——共享
 *   写路径锚定（零关系空数组分支与之共用同一写路径）。
 * - R48-79：book.yaml 缺失/损坏时总览显式 500 IO_ERROR（此前静默代答默认身份，
 *   对齐 books.ts 低-3「读失败显式报错不代答」口径）。
 * R48-76（TOCTOU 兜底 catch）与 R48-80（模型档位调用前快照）为防御性/取值时点收口，
 * HTTP 层不可确定性触发，靠既有套件回归 + 代码面评审锚定。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

const BOOK = 'R48修复书'
const BOOK_BAD = 'R48坏账书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | unknown[] | null }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      origin: baseUrl,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: Record<string, unknown> | unknown[] | null = null
  try {
    json = (await r.json()) as Record<string, unknown> | unknown[] | null
  } catch {
    /* 非 JSON 留 null */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clw-r48-server-'))
  const userDataPath = mkdtempSync(join(tmpdir(), 'clw-r48-server-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n' +
    JSON.stringify({ name: BOOK_BAD, path: BOOK_BAD, kind: 'long' }) + '\n',
  )
  // 正常书：book.yaml + 伏笔/正文目录 + 一章正文（relations/mine 的梳理材料）
  const root = join(workDir, BOOK)
  mkdirSync(join(root, '设定', '伏笔'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: R48修复书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '写作', '正文', '0001-章.md'),
    '---\n章号: 1\n标题: 第一章\n---\n\n主角登场，一路向东南。\n',
    'utf-8',
  )
  // 坏账书：只建目录不写 book.yaml（R48-79：总览不得静默代答默认身份）
  mkdirSync(join(workDir, BOOK_BAD), { recursive: true })
  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await (await fetch(`${baseUrl}/api/boot`)).json()
  token = boot.token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  delete process.env['CLWRITING_DRIVER']
})

describe('R48-19：伏笔端点 handler 改走 async 缓存壳', () => {
  it('GET foreshadows 经异步路径正常回包（entries 数组 + 足迹字段）', async () => {
    const { status, json } = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/foreshadows`)
    expect(status).toBe(200)
    expect(Array.isArray(json)).toBe(true)
  })
})

describe('R48-20：onboard-save 空 content 400', () => {
  it('content 缺失 → 400 BAD_INPUT「content 为空」，目标文件不被落盘', async () => {
    const { status, json } = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'synopsis',
    })
    expect(status).toBe(400)
    const env = json as { code?: string; error?: string }
    expect(env.code).toBe('BAD_INPUT')
    expect(env.error).toContain('content 为空')
    expect(existsSync(join(workDir, BOOK, '大纲', '总纲.md'))).toBe(false)
  })

  it('content 空串 → 同 400；非空 content 照常 200 落盘', async () => {
    const blank = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'synopsis',
      content: '   \n  ',
    })
    expect(blank.status).toBe(400)
    const ok = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
      step: 'synopsis',
      content: '# 总纲\n\n主角一路向东南。',
    })
    expect(ok.status).toBe(200)
    expect((ok.json as { ok?: boolean }).ok).toBe(true)
  })
})

describe('R48-77：关系梳理缓存写路径（共享写路径锚定）', () => {
  it('首次梳理 cached:false 落缓存，二次请求命中缓存 cached:true', async () => {
    const first = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/relations/mine`, {})
    expect(first.status).toBe(200)
    expect((first.json as { cached?: boolean }).cached).toBe(false)
    expect(Array.isArray((first.json as { relations?: unknown }).relations)).toBe(true)
    const second = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/relations/mine`, {})
    expect(second.status).toBe(200)
    expect((second.json as { cached?: boolean }).cached).toBe(true)
    expect((second.json as { relations?: unknown }).relations).toEqual((first.json as { relations?: unknown }).relations)
  })
})

describe('R48-79：book.yaml 读失败总览显式 500', () => {
  it('缺失 book.yaml → 500 IO_ERROR（不静默代答默认身份）', async () => {
    const { status, json } = await req('GET', `/api/books/${encodeURIComponent(BOOK_BAD)}/overview`)
    expect(status).toBe(500)
    expect((json as { code?: string }).code).toBe('IO_ERROR')
    expect(String((json as { error?: unknown }).error)).toContain('book.yaml')
  })
})
