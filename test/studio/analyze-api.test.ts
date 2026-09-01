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
import { startServerSafe } from '../helpers/safe-port.js'
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
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 分析测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  const chapterPath = join(bookRoot, '写作', '正文', '0001-开篇.md')
  writeFileSync(
    chapterPath,
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场，初入宗门，一切由此开始。\n',
    'utf8',
  )
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)

  server = await startServerSafe({ port: 0, workDir })
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
      join(workDir, BOOK, '写作', '正文', '0001-开篇.md'),
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
    const j = r.json as { ok: boolean; envelope: { payload: { segments: { emotion: number; label: string }[] } } }
    expect(j.ok).toBe(true)
    expect(Array.isArray(j.envelope.payload.segments)).toBe(true)
    expect(j.envelope.payload.segments.length).toBeGreaterThan(0)
    const e = j.envelope.payload.segments[0]!.emotion
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

describe('POST /documents/:docId/infer-meta（AI 反推目标情绪/核心反转）', () => {
  it('→ 200 + meta 含 目标情绪/核心反转（mock 产出）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/infer-meta`)
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; meta: { 目标情绪?: string; 核心反转?: string } }
    expect(j.ok).toBe(true)
    expect(j.meta.目标情绪).toBeTruthy()
    expect(j.meta.核心反转).toBeTruthy()
  })
})

// ── 低-5（第十轮）：analysis-overview 对坏信封 payload 的形状守卫 ──────────

describe('GET /analysis-overview：score/emotion 坏形状跳过该章（低-5）', () => {
  it('score 非数字 / emotion 末段缺字段 → 该章不入趋势，好数据照常聚合', async () => {
    const bookRoot = join(workDir, BOOK)
    // 第二章 + 登记（章 1 坏 emotion / 章 2 坏 score，交叉验证互不拖累）
    const docId2 = generateDocId()
    writeFileSync(
      join(bookRoot, '写作', '正文', '0002-次章.md'),
      '---\n章号: 2\n标题: 次章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第二章正文。\n',
      'utf8',
    )
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    upsertEntry(m, { id: docId2, nodeType: 'document', path: '写作/正文/0002-次章.md', parentId: null })
    writeManifest(manifestPath, m)

    // 直写分析信封（坏形状走真实 readAnalysis/isEnvelope 链路）
    const env = (payload: unknown) => ({
      generatedAt: new Date().toISOString(),
      model: 'mock',
      sourceHash: '0'.repeat(64),
      payload,
    })
    const analysisDir = join(bookRoot, '项目', '分析')
    mkdirSync(analysisDir, { recursive: true })
    // 章 1：score 好、emotion 坏（末段 emotion 非数字）
    writeFileSync(join(analysisDir, `${docId}.json`), JSON.stringify({
      score: env({ score: 8, dims: { 爽点: 8 } }),
      emotion: env({ segments: [{ emotion: 1, label: '起' }, { emotion: 'x', label: '伏' }] }),
    }))
    // 章 2：score 坏（score 缺失/非数字）、emotion 好
    writeFileSync(join(analysisDir, `${docId2}.json`), JSON.stringify({
      score: env({ dims: { 爽点: 8 } }),
      emotion: env({ segments: [{ emotion: -1, label: '抑' }] }),
    }))

    const r = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/analysis-overview`)
    expect(r.status).toBe(200)
    const j = r.json as {
      scoreTrend: { 章号: number; score: number }[]
      emotionTrend: { 章号: number; emotion: number; label: string }[]
    }
    // 坏形状只跳过该章的该 kind——score 趋势只剩章 1，且值为数字（无 NaN 入趋势）
    expect(j.scoreTrend).toHaveLength(1)
    expect(j.scoreTrend[0]!.章号).toBe(1)
    expect(typeof j.scoreTrend[0]!.score).toBe('number')
    expect(j.emotionTrend).toHaveLength(1)
    expect(j.emotionTrend[0]!.章号).toBe(2)
    expect(j.emotionTrend[0]!.emotion).toBe(-1)
    expect(j.emotionTrend[0]!.label).toBe('抑')
  })

  it('emotion segments 非数组（坏信封）→ 跳过该章不崩端点', async () => {
    const bookRoot = join(workDir, BOOK)
    const analysisDir = join(bookRoot, '项目', '分析')
    // 只重写章 1 的信封为坏形状（segments 非数组）；章 2 的好信封留盘对照
    writeFileSync(join(analysisDir, `${docId}.json`), JSON.stringify({
      emotion: { generatedAt: new Date().toISOString(), model: 'mock', sourceHash: '0'.repeat(64), payload: { segments: 'oops' } },
    }))
    const r = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/analysis-overview`)
    expect(r.status).toBe(200)
    const j = r.json as { emotionTrend: { 章号: number }[] }
    expect(j.emotionTrend.some((e) => e.章号 === 1)).toBe(false) // 坏形状章 1 被跳过
    expect(j.emotionTrend.every((e) => e.章号 === 2)).toBe(true) // 好信封章 2 照常聚合
  })
})
