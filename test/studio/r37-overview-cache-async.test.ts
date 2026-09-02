/**
 * R37-3 / R37-19（三十七轮批 D）回归：overview 端点的异步扫描与失败态不落缓存。
 *
 * R37-3：computeTimeline 原地异步化（模块私有函数，无同步对照版——固定期望守护）、
 * computeProgressAsync 接线——经真实 HTTP 端点断言 60 章书的 timeline 日聚合与
 * progress 投影正确（异步化不改结果）。
 *
 * R37-19：detectState 抛错时降级态（state:0 + error）此前同样写入 stateCache，TTL 内
 * 数据已修复的后续请求仍拿假空态；修复后只在成功路径落缓存。用 vi.mock 注入
 * mockRejectedValueOnce 强制首请求失败：断言首请求 200 + 降级态（端点既有契约是
 * fail-open 返 state:0 而非 5xx——与修复任务书描述的「首请求 5xx」有出入，以实际
 * 代码契约为准），第二请求（TTL 内）detectState 真实重跑、拿到非降级结果，第三次
 * 请求命中成功缓存（detectState 不再被调）。
 *
 * 另带 R37-3c 冒烟：GET /api/books 书架列表经 computeBookSummaryAsync 出摘要。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'

vi.mock('../../src/state/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/state.js')>()
  return { ...actual, detectState: vi.fn(actual.detectState) }
})

import { detectState } from '../../src/state/state.js'
import { forgetOverviewCache } from '../../src/studio/server/api/overview.js'
import { startServerSafe } from '../helpers/safe-port.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const detectStateMock = vi.mocked(detectState)

let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

/** 本地正午基准（避免本地日切边界），全书 60 章铺在 3 个本地日（20/20/20）。 */
function dayTime(daysAgo: number): number {
  const base = new Date()
  base.setHours(12, 0, 0, 0)
  return base.getTime() - daysAgo * 86_400_000
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r37-ov-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: '测试书', path: '测试书', kind: 'long' }) + '\n')
  bookRoot = join(workDir, '测试书')
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 测试书\n  genre: 仙侠\nkind: long\nhost: cc\n', 'utf-8')
  writeFileSync(join(bookRoot, '大纲', '总纲.md'), '# 总纲', 'utf-8')
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= 60; no++) {
    const pad = String(no).padStart(3, '0')
    const fp = join(bookRoot, '写作', '正文', `${pad}-第${no}章.md`)
    writeFileSync(
      fp,
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${no}章正文，字数若干。\n`,
      'utf-8',
    )
    const t = dayTime(no % 3) // 三日轮转：每本地日 20 章（utimesSync 传 Date——数字按秒解释会错乱）
    utimesSync(fp, new Date(t), new Date(t))
    const id = generateDocId()
    upsertEntry(m, { id, nodeType: 'document', path: `写作/正文/${pad}-第${no}章.md`, parentId: null })
    m.entries.get(id)!.finalizedRevision = 'sha256:' + 'a'.repeat(64) // 已定稿：timeline 计数口径
  }
  writeManifest(manifestPath, m)

  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { 'x-studio-token': token } })
}

interface OverviewBody {
  progress: { chapters: number; words: number }
  timeline: { date: string; count: number }[]
  state: { state: number; name: string; detail: { error?: string } }
}

describe('R37-3/R37-19 overview 端点', () => {
  it('R37-3：60 章书的 timeline 三日聚合（各 20）+ progress 投影正确（异步化不改结果）', async () => {
    const r = await get(`/api/books/${encodeURIComponent('测试书')}/overview`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as OverviewBody
    expect(body.progress.chapters).toBe(60)
    expect(body.progress.words).toBeGreaterThan(0)
    expect(body.timeline).toHaveLength(3)
    expect(body.timeline.reduce((s, t) => s + t.count, 0)).toBe(60)
    for (const t of body.timeline) expect(t.count).toBe(20)
  })

  it('R37-19：detectState 首次抛错 → 200 + 降级态且不落缓存；第二请求真实重跑拿正确结果；第三次命中成功缓存', async () => {
    forgetOverviewCache(bookRoot) // 隔离上一用例落下的成功缓存
    const callsBefore = detectStateMock.mock.calls.length
    detectStateMock.mockRejectedValueOnce(new Error('R37-19 注入：状态机判定失败'))

    const r1 = await get(`/api/books/${encodeURIComponent('测试书')}/overview`)
    expect(r1.status).toBe(200) // 端点既有契约：fail-open 返 state:0（任务书「首请求 5xx」与实态不符，以代码为准）
    const b1 = (await r1.json()) as OverviewBody
    expect(b1.state.state).toBe(0)
    expect(b1.state.name).toBe('状态机判定失败')
    expect(b1.state.detail.error).toBeTruthy()
    expect(detectStateMock.mock.calls.length).toBe(callsBefore + 1)

    // 立即二次请求（TTL 内）：失败态未落缓存 → detectState 真实重跑并成功（无 detail.error）
    const r2 = await get(`/api/books/${encodeURIComponent('测试书')}/overview`)
    expect(r2.status).toBe(200)
    const b2 = (await r2.json()) as OverviewBody
    expect(detectStateMock.mock.calls.length).toBe(callsBefore + 2) // 关键：未被假空缓存挡住
    expect(b2.state.detail.error).toBeUndefined()
    expect(b2.state.name).not.toBe('状态机判定失败')

    // 第三次：成功态落缓存（R37-19 只挡失败态）→ detectState 不再被调
    await get(`/api/books/${encodeURIComponent('测试书')}/overview`)
    expect(detectStateMock.mock.calls.length).toBe(callsBefore + 2)
  })

  it('R37-3c 冒烟：GET /api/books 书架摘要经 computeBookSummaryAsync 出（60 章）', async () => {
    const r = await get('/api/books')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { books: { name: string; chapters?: number; words?: number; damaged?: boolean }[] }
    const book = body.books.find((b) => b.name === '测试书')
    expect(book).toBeTruthy()
    expect(book!.damaged).not.toBe(true)
    expect(book!.chapters).toBe(60)
    expect(book!.words!).toBeGreaterThan(0)
  })
})
