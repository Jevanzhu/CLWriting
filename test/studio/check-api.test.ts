/**
 * POST /api/books/:name/documents/:docId/check 机检端点集成测（M12 块3 B3.1）。
 * 验证：正文文档 → 200 + CheckReport；非章节文档 → NOT_CHAPTER；未登记 docId → NOT_FOUND。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const BOOK = '机检测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let chapterDocId = ''
let nonChapterDocId = ''

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
            /* 非 JSON 响应留 null */
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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-check-api-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '定稿', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '定稿', '设定'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 机检测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  // 正文文档（完整章节 fm）
  writeFileSync(
    join(bookRoot, '定稿', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n这是正文内容，主角登场。\n',
    'utf8',
  )
  // 非章节文档（设定，fm 无章号/钩子字段）
  writeFileSync(join(bookRoot, '定稿', '设定', '角色.md'), '---\n标题: 角色\n---\n\n主角信息。\n', 'utf8')
  // manifest 登记 docId
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  chapterDocId = generateDocId()
  nonChapterDocId = generateDocId()
  upsertEntry(m, { id: chapterDocId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null })
  upsertEntry(m, { id: nonChapterDocId, nodeType: 'document', path: '定稿/设定/角色.md', parentId: null })
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
})

describe('POST /documents/:docId/check 机检（M12 块3 B3.1）', () => {
  it('正文文档 → 200 + CheckReport（含 sections）', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/check`, {})
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; report: { sections: unknown[] }; hasRed: boolean }
    expect(j.ok).toBe(true)
    expect(Array.isArray(j.report.sections)).toBe(true)
    expect(j.report.sections.length).toBeGreaterThan(0)
    // hasRed 是布尔（无论红黄）
    expect(typeof j.hasRed).toBe('boolean')
  })

  it('非章节文档（设定，fm 无章号/钩子）→ 400 NOT_CHAPTER', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${nonChapterDocId}/check`, {})
    expect(r.status).toBe(400)
    const j = r.json as { ok: boolean; code: string }
    expect(j.ok).toBe(false)
    expect(j.code).toBe('NOT_CHAPTER')
  })

  it('未登记 docId → 404 NOT_FOUND', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/doc_${'0'.repeat(26)}/check`, {})
    expect(r.status).toBe(404)
    const j = r.json as { ok: boolean; code: string }
    expect(j.code).toBe('NOT_FOUND')
  })
})
