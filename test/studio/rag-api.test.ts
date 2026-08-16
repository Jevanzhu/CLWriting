/**
 * cc 批4（P1-8）RAG 接线端点集成测：buildIndex 从零生产调用方变为 GUI 可触发。
 *
 * 覆盖：api_key 落 .clwriting/rag.secret（H1 不入 book.yaml）/ status 初始态 /
 * build 前置校验（未配置 → 400、缺 key → 400）/ build 成功后台跑完 → status 反映。
 * embed 用 vi.mock 桩（确定性向量，不联网）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../../src/studio/server/index.js'
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

const BOOK = 'RAG测试书'
let workDir = ''
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

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-rag-api-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  // 登记名 = book.yaml title = 目录名（启动 repair 以 title 为真相源，构造对齐避免被改）
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

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) {
    // 强制断开 keep-alive 空闲连接，防 close 回调因连接池挂起
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('cc批4 RAG 接线（P1-8）', () => {
  it('api_key 端点：写 .clwriting/rag.secret（gitignore 区，不入 book.yaml）', async () => {
    const r = await api('/rag/key', { method: 'POST', body: JSON.stringify({ apiKey: 'sk-test-123' }) })
    expect(r.status).toBe(200)
    expect(readFileSync(join(workDir, '.clwriting', 'rag.secret'), 'utf-8').trim()).toBe('sk-test-123')
    // H1：key 绝不进 book.yaml
    expect(readFileSync(join(workDir, BOOK, 'book.yaml'), 'utf-8')).not.toContain('sk-test-123')
    // 空 key → 400
    const bad = await api('/rag/key', { method: 'POST', body: JSON.stringify({ apiKey: '' }) })
    expect(bad.status).toBe(400)
  })

  it('status 初始态：未建过索引 → 全零 + lastResult null', async () => {
    const r = await api('/rag/status')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ running: false, indexedChapters: 0, chunkCount: 0, lastResult: null })
  })

  it('build 未配置 RAG（book.yaml 无 rag 段）→ 400 前置校验', async () => {
    const r = await api('/rag/build', { method: 'POST', body: '{}' })
    expect(r.status).toBe(400)
    expect(String(r.json['error'])).toContain('RAG 未完整配置')
  })

  it('配置 rag 段后 build：后台跑完 → status 反映已索引章/块', async () => {
    // 配置 rag 段：GET 现有完整 config → 加 rag → PUT（stringifyBookConfig 需要全结构）
    const get = await api('/config')
    expect(get.status).toBe(200)
    const cfg = get.json['config'] as Record<string, unknown>
    ;(cfg as { rag: unknown })['rag'] = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    const put = await api('/config', { method: 'PUT', body: JSON.stringify({ config: cfg }) })
    expect(put.status).toBe(200)

    const r = await api('/rag/build', { method: 'POST', body: '{}' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ started: true })

    // 后台任务完成 → status 反映
    const done = await waitForStatus((s) => s['running'] === false && (s['chunkCount'] as number) > 0)
    expect(done['indexedChapters']).toBeGreaterThanOrEqual(1)
    expect(done['lastResult']).toMatchObject({ ok: true })
    expect(done['model']).toBe('stub-model')
  })

  it('build 再跑：增量无新块（幂等）', async () => {
    const r = await api('/rag/build', { method: 'POST', body: '{}' })
    expect(r.status).toBe(200)
    const done = await waitForStatus((s) => s['running'] === false && (s['lastResult'] as { ok: boolean })?.ok === true)
    expect((done['lastResult'] as { chunkCount: number }).chunkCount).toBe(0) // 增量：无新块
  })
})
