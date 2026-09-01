/**
 * R26-16（二十六轮）：rag/rebuild 端点闭环回归——修复「请重建索引」死路。
 *
 * 闭环：换模型 → build 失败（错误信封指向 /rag/rebuild）+ status 透出失配 →
 * POST /rag/rebuild（同 'rag-build' 任务闸，闸内 resetRagIndex 清库）→ build 成功 →
 * 召回恢复。embed 用 vi.mock 桩（确定性向量，不联网，手法对齐 rag-api.test.ts）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServerSafe } from '../helpers/safe-port.js'
import { isTaskGateHeld } from '../../src/studio/server/api/task-gate.js'
import { recall } from '../../src/rag/index.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'

// 桩 embed（确定性向量，不联网）——RAG 引擎默认 embed 在这里被替换
vi.mock('../../src/rag/embed.js', () => ({
  embed: async (_endpoint: string, _model: string, _key: string, texts: string[]) =>
    texts.map((t) => {
      const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
}))

const BOOK = 'RAG重建书'
let workDir = ''
let userData = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function api(path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}${path}`, {
    ...init,
    headers: { 'x-studio-token': token, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }))
}

/** 轮询 status 直到谓词成立（后台 buildIndex 完成等待） */
async function waitForStatus(
  predicate: (s: Record<string, unknown>) => boolean,
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await api('/rag/status')
    if (predicate(r.json)) return r.json
    await new Promise((r2) => setTimeout(r2, 50))
  }
  throw new Error('waitForStatus 超时')
}

/** PUT 全量 config（GET 现有完整 config → 改 rag → PUT） */
async function putRagCfg(rag: Record<string, unknown>): Promise<void> {
  const get = await api('/config')
  expect(get.status).toBe(200)
  const cfg = get.json['config'] as Record<string, unknown>
  ;(cfg as { rag: unknown })['rag'] = rag
  const put = await api('/config', { method: 'PUT', body: JSON.stringify({ config: cfg }) })
  expect(put.status).toBe(200)
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-rag-rebuild-'))
  userData = mkdtempSync(join(tmpdir(), 'clwriting-rag-rebuild-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK}\n  genre: 玄幻\nhost: cc\n`,
    'utf8',
  )
  for (const n of [1, 2]) {
    const meta: ChapterMeta = {
      章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
      _path: '', _wordCount: 100,
    }
    writeChapter(
      join(bookRoot, '写作', '正文', `${n}-第${n}章.md`),
      meta,
      `第${n}章的正文段落内容，这是一个战斗场景，主角挥剑战斗。`,
    )
  }

  server = await startServerSafe({ port: 0, workDir, userDataPath: userData })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userData) rmSync(userData, { recursive: true, force: true })
})

describe('R26-16：rag/rebuild 闭环（失配 → 重建 → 召回恢复）', () => {
  it('未配置 RAG 时 rebuild → 400 前置校验（与 build 同闸同信封，不清库）', async () => {
    const r = await api('/rag/rebuild', { method: 'POST', body: '{}' })
    expect(r.status).toBe(400)
    expect(String(r.json['error'])).toContain('知识检索未启用')
  })

  it('闭环：模型 A 建库 → 换模型 B 失配死路 → rebuild → 模型 B 建库成功 → 召回恢复', async () => {
    // 1. 旧版内联配置（模型 A）→ build 成功
    writeFileSync(join(workDir, '.clwriting', 'rag.secret'), 'sk-legacy-key\n', 'utf8')
    await putRagCfg({ enabled: true, endpoint: 'http://stub-legacy', model: 'model-a' })
    expect((await api('/rag/build', { method: 'POST', body: '{}' })).status).toBe(200)
    const built = await waitForStatus((s) => s['running'] === false && (s['chunkCount'] as number) > 0)
    expect(built['model']).toBe('model-a')
    expect(built['indexModelMismatch']).toBe(false)

    // 2. 换模型 B：status 透出失配；引擎 recall 走模型守卫降级为空（B 视角下无可用索引）
    await putRagCfg({ enabled: true, endpoint: 'http://stub-legacy', model: 'model-b' })
    const mismatched = await api('/rag/status')
    expect(mismatched.json['indexModelMismatch']).toBe(true)
    const bookRoot = join(workDir, BOOK)
    const cfgB = { enabled: true, endpoint: 'http://stub-legacy', model: 'model-b' } as const
    await expect(recall(bookRoot, { ...cfgB }, 'sk-legacy-key', '第1章', 5)).resolves.toEqual([])

    // 3. 直接 build：错误信封指向重建端点（修复前是「请重建索引」死路，无程序化出路）
    expect((await api('/rag/build', { method: 'POST', body: '{}' })).status).toBe(200)
    const failed = await waitForStatus(
      (s) => s['running'] === false && (s['lastResult'] as { ok: boolean })?.ok === false,
    )
    const failError = String((failed['lastResult'] as { error: string }).error)
    expect(failError).toContain('模型与现有索引不一致')
    expect(failError).toContain('POST /rag/rebuild')

    // 4. rebuild：同任务闸清库重建 → 成功、模型换成 B、失配标记复位
    const rb = await api('/rag/rebuild', { method: 'POST', body: '{}' })
    expect(rb.status).toBe(200)
    expect(rb.json).toMatchObject({ started: true, reset: true })
    const rebuilt = await waitForStatus((s) => {
      const last = s['lastResult'] as { ok: boolean } | null
      return s['running'] === false && last !== null && last.ok === true
    })
    expect(rebuilt['model']).toBe('model-b')
    expect(rebuilt['chunkCount'] as number).toBeGreaterThan(0)
    expect(rebuilt['indexModelMismatch']).toBe(false)
    // 任务闸已释放（后续 rebuild 不 409）
    expect(isTaskGateHeld(BOOK, 'rag-build')).toBe(false)

    // 5. 召回恢复：B 视角下正常命中
    const hits = await recall(bookRoot, { ...cfgB }, 'sk-legacy-key', '第1章', 5)
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) expect(h.章号).toBeGreaterThanOrEqual(1)
  })

  it('rebuild 后建索引覆盖全新章集合（游标/指纹已清，改动章全部重嵌）', async () => {
    // 承接上一闭环（索引为 model-b 全新书）：再 rebuild 一次，增量游标被清 → 全章重索引
    const rb = await api('/rag/rebuild', { method: 'POST', body: '{}' })
    expect(rb.status).toBe(200)
    const rebuilt = await waitForStatus((s) => {
      const last = s['lastResult'] as { ok: boolean; chunkCount: number } | null
      return s['running'] === false && last !== null && last.ok === true
    })
    // 若游标/指纹未清，增量幂等会返回 chunkCount 0——重建语义要求全量重嵌
    expect((rebuilt['lastResult'] as { chunkCount: number }).chunkCount).toBeGreaterThan(0)
  })
})
