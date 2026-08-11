/**
 * POST /api/books/:name/documents/:docId/review 三审直读端点集成测（M12 块1 B0.2）。
 * mock driver 下验证全链路：机检 → buildReviewPacket → generateTool(submit_issues)×3 → collectReviewIssues → 落信封。
 *（mock driver 样本文本非 issues JSON，collected.ok 可能 false；B1.4 改 mock 按 role 返 JSON 后才断言意见。）
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const BOOK = '三审测试书'
let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let chapterDocId = ''
const prevDriver = process.env['CLWRITING_DRIVER']

function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: {
          'x-studio-token': token,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
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
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-review-doc-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '定稿', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲', '悬念'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 三审测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\nbudget:\n  calls_per_chapter: 8\n',
    'utf8',
  )
  writeFileSync(
    join(bookRoot, '定稿', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场，玉佩发光，宗门震动。\n',
    'utf8',
  )
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  chapterDocId = generateDocId()
  upsertEntry(m, { id: chapterDocId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('POST /documents/:docId/review 三审直读（M12 B0.2）', () => {
  it('正文文档 → 200 + lenses + collected + 信封落盘（kind=review）', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/review`, {})
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; lenses: string[]; collected: { chapter: number; lenses_run: string[] } }
    expect(j.ok).toBe(true)
    expect(j.lenses.length).toBeGreaterThan(0)
    expect(j.collected.chapter).toBe(1)

    // 信封落盘：项目/分析/<docId>.json 含 review kind
    const envPath = join(bookRoot, '项目', '分析', `${chapterDocId}.json`)
    expect(existsSync(envPath)).toBe(true)
    const env = JSON.parse(readFileSync(envPath, 'utf-8')) as { review: { sourceHash: string; payload: { collected: unknown } } }
    expect(env.review).toBeTypeOf('object')
    expect(typeof env.review.sourceHash).toBe('string')
    expect(env.review.payload.collected).not.toBeUndefined()
  })

  it('未登记 docId → 404 NOT_FOUND', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/doc_${'0'.repeat(26)}/review`, {})
    expect(r.status).toBe(404)
    const j = r.json as { ok: boolean; code: string }
    expect(j.code).toBe('NOT_FOUND')
  })
})
