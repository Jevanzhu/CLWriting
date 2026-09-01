/**
 * R35-13（三十五轮）端点回归：rag.db 文件级损坏 → status 结构化指引（非裸 500）、
 * rebuild 删库重建恢复可用。
 *
 * 闭环：正常建库 → 主库文件覆写为垃圾字节（断电/杀软半写的文件级损坏形态）→
 * GET /rag/status 返回 500 RAG_DB_CORRUPT（带「损坏，请重建」人话指引，修复前 handler
 * 抛错走 dispatch 兜底裸 500）→ POST /rag/rebuild（resetRagIndex 确认损坏删库重建）
 * → build 成功、status 恢复 200。embed 用 vi.mock 桩（手法对齐 rag-rebuild-api.test.ts）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServerSafe } from '../helpers/safe-port.js'
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

const BOOK = 'RAG损坏书'
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

async function putRagCfg(rag: Record<string, unknown>): Promise<void> {
  const get = await api('/config')
  expect(get.status).toBe(200)
  const cfg = get.json['config'] as Record<string, unknown>
  ;(cfg as { rag: unknown })['rag'] = rag
  const put = await api('/config', { method: 'PUT', body: JSON.stringify({ config: cfg }) })
  expect(put.status).toBe(200)
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r35-corrupt-'))
  userData = mkdtempSync(join(tmpdir(), 'clwriting-r35-corrupt-ud-'))
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

describe('R35-13：rag.db 损坏 → status 结构化指引 → rebuild 恢复', () => {
  it('闭环：建库 → 覆写垃圾字节 → status 500 RAG_DB_CORRUPT → rebuild → 恢复可用', async () => {
    const bookRoot = join(workDir, BOOK)
    const dbPath = join(bookRoot, '.cache', 'rag.db')

    // 0. 基线：旧版内联配置建库成功
    writeFileSync(join(workDir, '.clwriting', 'rag.secret'), 'sk-legacy-key\n', 'utf8')
    await putRagCfg({ enabled: true, endpoint: 'http://stub-legacy', model: 'model-a' })
    expect((await api('/rag/build', { method: 'POST', body: '{}' })).status).toBe(200)
    await waitForStatus((s) => s['running'] === false && (s['chunkCount'] as number) > 0)

    // 1. 文件级损坏：主库整文件覆写为非 SQLite 字节流（此刻无打开句柄——build 已收尾）
    writeFileSync(dbPath, 'broken by power loss, definitely not a sqlite db'.repeat(8), 'utf8')

    // 2. status：结构化错误 + 人话指引（修复前 openRagDb 原样上抛 → 兜底裸 500 无出路）
    const st = await api('/rag/status')
    expect(st.status).toBe(500)
    expect(st.json['code']).toBe('RAG_DB_CORRUPT')
    expect(String(st.json['error'])).toContain('损坏')
    expect(String(st.json['error'])).toContain('重建')

    // 3. rebuild：resetRagIndex 确认损坏 → 删库（连 -wal/-shm）全新建 → 后台 build 重嵌
    const rb = await api('/rag/rebuild', { method: 'POST', body: '{}' })
    expect(rb.status).toBe(200)
    expect(rb.json).toMatchObject({ started: true, reset: true })
    const rebuilt = await waitForStatus((s) => {
      const last = s['lastResult'] as { ok: boolean; chunkCount: number } | null
      return s['running'] === false && last !== null && last.ok === true
    })
    expect((rebuilt['lastResult'] as { chunkCount: number }).chunkCount).toBeGreaterThan(0)

    // 4. status 恢复 200、块数可见
    const after = await api('/rag/status')
    expect(after.status).toBe(200)
    expect(after.json['chunkCount'] as number).toBeGreaterThan(0)
  })
})
