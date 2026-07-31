/**
 * POST /documents/:docId/analyze + GET /analysis/:kind 集成测（M12 块4 B4.0/B4.1）。
 * mock driver（analyst role，按 [kind:x] 标记分发）下验证：
 * - score 分析 → 落信封（payload.score=8）
 * - GET 读回 + stale=false
 * - 改正文 → stale=true（过期标注）
 * - kind=review → 400（review 走独立三审端点）
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

const BOOK = '分析测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let docId = ''
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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-analyze-'))
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
    'spec_version: 1\nkind: long\nbook:\n  title: 分析测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  const chapterPath = join(bookRoot, '定稿', '正文', '0001-开篇.md')
  writeFileSync(
    chapterPath,
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场，初入宗门，一切由此开始。\n',
    'utf8',
  )
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null })
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

describe('POST /documents/:docId/analyze + GET /analysis/:kind（M12 B4.0/B4.1）', () => {
  it('score 分析 → 200 + 落信封（payload.score=8）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/analyze`, {
      kind: 'score',
    })
    expect(r.status).toBe(200)
    const j = r.json as {
      ok: boolean
      envelope: {
        payload: { score: number; verdict: string; dims: Record<string, number> }
        model: string
        sourceHash: string
      }
    }
    expect(j.ok).toBe(true)
    expect(j.envelope.payload.score).toBe(8)
    expect(j.envelope.payload.dims['爽点']).toBe(8)
    expect(j.envelope.model).toBe('mock')
    expect(j.envelope.sourceHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('GET /analysis/score 读回存量 + stale=false', async () => {
    const r = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/analysis/score`)
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; stale: boolean; envelope: { payload: { score: number } } }
    expect(j.ok).toBe(true)
    expect(j.stale).toBe(false)
    expect(j.envelope.payload.score).toBe(8)
  })

  it('改正文 → GET stale=true（过期标注）', async () => {
    writeFileSync(
      join(workDir, BOOK, '定稿', '正文', '0001-开篇.md'),
      '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场，剧情已被作者改动。\n',
      'utf8',
    )
    const r = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/analysis/score`)
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; stale: boolean }
    expect(j.stale).toBe(true)
  })

  it('emotion 分析 → 200 + payload 数组（emotion -2..2）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/analyze`, {
      kind: 'emotion',
    })
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; envelope: { payload: { emotion: number; label: string }[] } }
    expect(j.ok).toBe(true)
    expect(Array.isArray(j.envelope.payload)).toBe(true)
    expect(j.envelope.payload.length).toBeGreaterThan(0)
    const e = j.envelope.payload[0]!.emotion
    expect(e).toBeGreaterThanOrEqual(-2)
    expect(e).toBeLessThanOrEqual(2)
  })

  it('hooks 分析 → 200 + payload.hooks 数组 + density', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/analyze`, {
      kind: 'hooks',
    })
    expect(r.status).toBe(200)
    const j = r.json as {
      ok: boolean
      envelope: { payload: { hooks: { pos: string; strength: number }[]; density: string } }
    }
    expect(j.ok).toBe(true)
    expect(Array.isArray(j.envelope.payload.hooks)).toBe(true)
    expect(['疏', '中', '密']).toContain(j.envelope.payload.density)
  })

  it('style 分析 → 200 + payload（drift + 建议，附本地 stats/IronRules 为底）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/analyze`, {
      kind: 'style',
    })
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; envelope: { payload: { drift: string; 建议: string[] } } }
    expect(j.ok).toBe(true)
    expect(typeof j.envelope.payload.drift).toBe('string')
    expect(Array.isArray(j.envelope.payload.建议)).toBe(true)
  })

  it('kind=review → 400（review 走独立三审端点）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/analyze`, {
      kind: 'review',
    })
    expect(r.status).toBe(400)
  })

  it('全书 analyze-style → 源3 落候选（口癖→禁词 + 建议→手法）；重跑走查重闸', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/analyze-style`)
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; styleCandidates: number }
    expect(j.ok).toBe(true)
    expect(j.styleCandidates).toBe(2) // mock 口癖 ×1 + mock 建议 ×1

    const again = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/analyze-style`)
    expect((again.json as { styleCandidates: number }).styleCandidates).toBe(0)
  })
})
