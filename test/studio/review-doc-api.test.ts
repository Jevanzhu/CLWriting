/**
 * POST /api/books/:name/documents/:docId/review 三审直读端点集成测（M12 块1 B0.2）。
 * mock driver 下验证全链路：机检 → buildReviewPacket → generateTool(submit_issues)×3 → collectReviewIssues → 落信封。
 * mock submit_issues 返合法 issues JSON → 断言 collected.ok（W-P1-1 回归：预算降级合审档
 * 必须写 issues-combined.json，collect 才收得到，否则作者把预算调成 1-2 时三审必「不成立」）。
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
  it('正文文档 → 200 + lenses + collected.ok + 信封落盘（kind=review）', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/review`, {})
    expect(r.status).toBe(200)
    const j = r.json as {
      ok: boolean
      lenses: string[]
      collected: { ok: boolean; chapter: number; tier: string; lenses_run: string[]; missing_lenses: string[] }
    }
    expect(j.ok).toBe(true)
    expect(j.lenses.length).toBeGreaterThan(0)
    // mock submit_issues 返合法 issues → 独立档逐文件可回收，审稿单成立
    expect(j.collected.ok).toBe(true)
    expect(j.collected.missing_lenses).toEqual([])
    expect(j.collected.chapter).toBe(1)
    expect(j.collected.tier).not.toBe('combined')

    // 信封落盘：项目/分析/<docId>.json 含 review kind
    const envPath = join(bookRoot, '项目', '分析', `${chapterDocId}.json`)
    expect(existsSync(envPath)).toBe(true)
    const env = JSON.parse(readFileSync(envPath, 'utf-8')) as { review: { sourceHash: string; payload: { collected: unknown } } }
    expect(env.review).toBeTypeOf('object')
    expect(typeof env.review.sourceHash).toBe('string')
    expect(env.review.payload.collected).not.toBeUndefined()
  })

  it('预算 1 → 降级合审档 → issues-combined.json 契约 + collected.ok（W-P1-1 回归）', async () => {
    // 长篇无布线 = 2 视角；calls_per_chapter: 1 < 2 → selectReviewTier 降 combined（单文件单调用）
    const bookYaml = join(bookRoot, 'book.yaml')
    const origYaml = readFileSync(bookYaml, 'utf8')
    writeFileSync(bookYaml, origYaml.replace('calls_per_chapter: 8', 'calls_per_chapter: 1'), 'utf8')
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/review`, {})
      expect(r.status).toBe(200)
      const j = r.json as {
        ok: boolean
        lenses: string[]
        collected: { ok: boolean; tier: string; lenses_run: string[]; collected_lenses: string[]; missing_lenses: string[] }
      }
      expect(j.ok).toBe(true)
      expect(j.collected.tier).toBe('combined')
      // 合审单文件视为全视角覆盖：无缺失、审稿单成立（修复前写 issues-<锚视角>.json → 全缺失 + ok:false）
      expect(j.collected.ok).toBe(true)
      expect(j.collected.missing_lenses).toEqual([])
      expect(j.collected.collected_lenses.sort()).toEqual([...j.collected.lenses_run].sort())
      // 合审 = 单次调用，HTTP lenses 只含锚视角
      expect(j.lenses.length).toBe(1)
    } finally {
      writeFileSync(bookYaml, origYaml, 'utf8')
    }
  })

  it('未登记 docId → 404 NOT_FOUND', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/doc_${'0'.repeat(26)}/review`, {})
    expect(r.status).toBe(404)
    const j = r.json as { ok: boolean; code: string }
    expect(j.code).toBe('NOT_FOUND')
  })
})
