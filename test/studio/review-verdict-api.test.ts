/**
 * POST /documents/:docId/review-verdict 集成测（M12 B1.3 方案 A）。
 * 验证：verdict 落 review 信封 payload.verdict（不改 fm / deriveStatus）；通过/驳回 可切换覆盖。
 * 手写线不走 finalize；verdict 纯展示标记 + 信封存档。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const BOOK = '裁决测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let docId = ''

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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-verdict-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '定稿', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 裁决测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  writeFileSync(
    join(bookRoot, '定稿', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场。\n',
    'utf8',
  )
  const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null })
  writeManifest(join(bookRoot, '项目', '文档清单.jsonl'), m)

  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('POST /documents/:docId/review-verdict（M12 B1.3 方案 A）', () => {
  it('verdict 通过 → 200 + 落信封 payload.verdict.approved=true', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/review-verdict`, {
      approved: true,
    })
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; verdict: { approved: boolean; at: string } }
    expect(j.ok).toBe(true)
    expect(j.verdict.approved).toBe(true)
    expect(j.verdict.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('GET analysis/review 读回 verdict', async () => {
    const r = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/analysis/review`)
    expect(r.status).toBe(200)
    const j = r.json as {
      ok: boolean
      envelope: { payload: { verdict?: { approved: boolean } }; model: string }
    }
    expect(j.envelope.payload.verdict?.approved).toBe(true)
    expect(j.envelope.model).toBe('author')
  })

  it('verdict 驳回 → 覆盖为 approved=false', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/review-verdict`, {
      approved: false,
    })
    expect(r.status).toBe(200)
    expect((r.json as { verdict: { approved: boolean } }).verdict.approved).toBe(false)
    // 读回确认覆盖
    const g = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/analysis/review`)
    expect((g.json as { envelope: { payload: { verdict: { approved: boolean } } } }).envelope.payload.verdict.approved).toBe(false)
  })

  it('未登记 docId → 404', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${'z'.repeat(26)}/review-verdict`, {
      approved: true,
    })
    expect(r.status).toBe(404)
  })
})
