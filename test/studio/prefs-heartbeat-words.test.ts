/**
 * 书级本地三端点集成测（ii 报告测试缺口清偿——此前仅模块层单测，HTTP 层零直接测试）：
 * - GET/PUT /api/books/:name/prefs（.clwriting/prefs.json 读写 + BAD_INPUT 信封 + 坏文件降级）
 * - POST/DELETE /api/books/:name/heartbeat（工作区/.gui-active 续期/清除）
 * - GET/POST /api/books/:name/words-diary（项目/字数日记.jsonl 基线 + delta 空态 null）
 * 未知书一律 404 {code:'NOT_FOUND'}（resolveBook 公共闸）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { guiActivePath, readGuiActive } from '../../src/process/gui-active.js'
import { wordsDiaryPath, todayDate } from '../../src/document/words-diary.js'

const BOOK = '端点书'
let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 响应留 null */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-local-ep-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: `长篇/${BOOK}`, kind: 'long' }) + '\n',
  )
  bookRoot = join(workDir, '长篇', BOOK)
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK}\nhost: cc\n`)

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('GET/PUT /api/books/:name/prefs', () => {
  it('GET 无文件 → {prefs:{}, revision:0}；坏 JSON 同样降级不 500', async () => {
    const r = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/prefs`)
    expect(r.status).toBe(200)
    // R36-24：书级 prefs 对齐全局 prefs 的 revision 保留键口径——GET 剥离保留键单独回传
    expect(r.json).toEqual({ prefs: {}, revision: 0 })

    const fp = join(bookRoot, '.clwriting', 'prefs.json')
    mkdirSync(join(bookRoot, '.clwriting'), { recursive: true })
    writeFileSync(fp, '{oops')
    const bad = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/prefs`)
    expect(bad.status).toBe(200)
    expect(bad.json).toEqual({ prefs: {}, revision: 0 })
  })

  it('PUT 合法对象 → 落盘（含服务端管理的 revision 保留键）+ GET 读回一致（剥离 revision）', async () => {
    const prefs = { pageWidth: 720, leftWidth: 260, treeExpanded: ['卷一', '卷二'], activeDocId: null }
    const put = await req('PUT', `/api/books/${encodeURIComponent(BOOK)}/prefs`, { prefs })
    expect(put.status).toBe(200)
    // R36-24：响应带自增 revision（存量文件损坏视作 0 → 本次 1）；expectedRevision 不带则直通
    expect(put.json).toEqual({ ok: true, revision: 1 })
    expect(JSON.parse(readFileSync(join(bookRoot, '.clwriting', 'prefs.json'), 'utf8'))).toEqual({ ...prefs, revision: 1 })
    const get = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/prefs`)
    expect(get.json).toEqual({ prefs, revision: 1 })
  })

  it('PUT prefs 缺失/数组 → 400 BAD_INPUT 信封；未知书 GET → 404 NOT_FOUND', async () => {
    for (const body of [{}, { prefs: [1, 2] }, { prefs: 'x' }]) {
      const r = await req('PUT', `/api/books/${encodeURIComponent(BOOK)}/prefs`, body)
      expect(r.status).toBe(400)
      expect(r.json).toEqual({ code: 'BAD_INPUT', error: 'prefs 必填且须为对象' })
    }
    const nf = await req('GET', '/api/books/不存在的书/prefs')
    expect(nf.status).toBe(404)
    expect(nf.json).toEqual({ code: 'NOT_FOUND', error: '没有这本书：不存在的书' })
  })
})

describe('POST/DELETE /api/books/:name/heartbeat', () => {
  it('POST 续期 → 工作区/.gui-active {pid, ts}；再 POST ts 单调；DELETE 清除', async () => {
    const first = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/heartbeat`)
    expect(first.status).toBe(200)
    expect(first.json).toEqual({ ok: true })
    const rec1 = readGuiActive(bookRoot)
    expect(rec1).not.toBeNull()
    expect(rec1!.pid).toBe(process.pid)
    expect(rec1!.ts).toBeTypeOf('number')
    expect(existsSync(guiActivePath(bookRoot))).toBe(true)

    await new Promise((r) => setTimeout(r, 5))
    await req('POST', `/api/books/${encodeURIComponent(BOOK)}/heartbeat`)
    const rec2 = readGuiActive(bookRoot)
    expect(rec2!.ts).toBeGreaterThanOrEqual(rec1!.ts)

    const del = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/heartbeat`)
    expect(del.status).toBe(200)
    expect(del.json).toEqual({ ok: true })
    expect(existsSync(guiActivePath(bookRoot))).toBe(false)
  })

  it('未知书 POST → 404 NOT_FOUND 信封（resolveBook 先挡，不落盘）', async () => {
    const r = await req('POST', '/api/books/不存在的书/heartbeat')
    expect(r.status).toBe(404)
    expect(r.json).toEqual({ code: 'NOT_FOUND', error: '没有这本书：不存在的书' })
  })
})

describe('GET/POST /api/books/:name/words-diary', () => {
  it('GET 空态 → 今日日期 + baseline/delta 均 null；POST 后 baseline 读回', async () => {
    const g0 = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/words-diary`)
    expect(g0.status).toBe(200)
    expect(g0.json).toEqual({ ok: true, date: todayDate(), baseline: null, delta: null })

    const p = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/words-diary`, { baseline: 1234 })
    expect(p.status).toBe(200)
    expect(p.json).toEqual({ ok: true })
    const lines = readFileSync(wordsDiaryPath(bookRoot), 'utf8').trim().split('\n')
    expect(JSON.parse(lines[lines.length - 1]!)).toEqual({ date: todayDate(), baseline: 1234 })

    const g1 = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/words-diary`)
    expect(g1.json).toMatchObject({ ok: true, date: todayDate(), baseline: 1234, delta: null })
  })

  it('POST baseline 负数/非数字/缺失 → 400 BAD_INPUT 信封；未知书 GET → 404', async () => {
    for (const body of [{ baseline: -5 }, { baseline: 'abc' }, {}]) {
      const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/words-diary`, body)
      expect(r.status).toBe(400)
      expect(r.json).toEqual({ code: 'BAD_INPUT', error: 'baseline 需非负数' })
    }
    const nf = await req('GET', '/api/books/不存在的书/words-diary')
    expect(nf.status).toBe(404)
    expect(nf.json).toEqual({ code: 'NOT_FOUND', error: '没有这本书：不存在的书' })
  })
})
