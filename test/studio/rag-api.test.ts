/**
 * cc 批4（P1-8）RAG 接线端点集成测：buildIndex 从零生产调用方变为 GUI 可触发。
 * 服务商化改版：书存 rag.provider 引用应用级 RAG 服务商；旧版内联 endpoint/model 回落仍可用。
 *
 * 覆盖：status 初始态 / build 前置校验（未配置 → 400）/ 旧版内联 + rag.secret 回落 build /
 * 服务商引用 build（status 回显 providerName）/ 增量幂等。
 * embed 用 vi.mock 桩（确定性向量，不联网）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startServerSafe } from '../helpers/safe-port.js'
import { createRagTables } from '../../src/rag/schema.js'
import { storeChunk, setRagMeta } from '../../src/rag/store.js'
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

/** 全局路径请求（rag-providers 管理端点不在 /api/books 下） */
function gapi(path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${baseUrl}${path}`, {
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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-rag-api-'))
  userData = mkdtempSync(join(tmpdir(), 'clwriting-rag-user-'))
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

  server = await startServerSafe({ port: 0, workDir, userDataPath: userData })
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
  if (userData) rmSync(userData, { recursive: true, force: true })
})

describe('RAG 接线（P1-8 服务商化）', () => {
  it('status 初始态：未建过索引 → 全零 + lastResult null', async () => {
    const r = await api('/rag/status')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ running: false, indexedChapters: 0, chunkCount: 0, lastResult: null, providerName: null })
  })

  it('build 未配置 RAG（book.yaml 无 rag 段）→ 400 前置校验', async () => {
    const r = await api('/rag/build', { method: 'POST', body: '{}' })
    expect(r.status).toBe(400)
    expect(String(r.json['error'])).toContain('知识检索未启用')
  })

  it('旧版内联（endpoint/model 直存 + rag.secret 落 key）→ build 可用（存量兼容回落）', async () => {
    writeFileSync(join(workDir, '.clwriting', 'rag.secret'), 'sk-legacy-key\n', 'utf8')
    await putRagCfg({ enabled: true, endpoint: 'http://stub-legacy', model: 'stub-model' })

    const r = await api('/rag/build', { method: 'POST', body: '{}' })
    expect(r.status).toBe(200)
    const done = await waitForStatus((s) => s['running'] === false && (s['chunkCount'] as number) > 0)
    expect(done['indexedChapters']).toBeGreaterThanOrEqual(1)
    expect(done['lastResult']).toMatchObject({ ok: true })
    expect(done['model']).toBe('stub-model')
    // 旧版：legacy=true、无 providerName
    expect(done['legacy']).toBe(true)
    expect(done['providerName']).toBeNull()
  })

  it('书级 rag.provider 引用应用级服务商 → build 走服务商（status 回显 providerName）', async () => {
    // 造一个 RAG 服务商（key 走 vault，模型名与旧索引一致避免触发重建拦截）
    const create = await gapi('/api/rag-providers', {
      method: 'POST',
      body: JSON.stringify({ name: '测试嵌入', endpoint: 'http://stub-prov', model: 'stub-model', apiKey: 'sk-rag-test-123' }),
    })
    expect(create.status).toBe(200)
    const providerId = (create.json['provider'] as { id: string }).id
    expect(providerId.startsWith('rag-')).toBe(true)

    await putRagCfg({ enabled: true, provider: providerId })

    const r = await api('/rag/build', { method: 'POST', body: '{}' })
    expect(r.status).toBe(200)
    const done = await waitForStatus((s) => s['running'] === false && (s['lastResult'] as { ok: boolean })?.ok === true)
    expect(done['providerName']).toBe('测试嵌入')
    expect(done['legacy']).toBe(false)
    // 书的 rag 段只剩 enabled + provider（endpoint/model 已由迁移语义清掉）
    expect(done['ragConfig']).toMatchObject({ enabled: true, provider: providerId })
  })

  it('build 再跑：增量无新块（幂等）', async () => {
    const r = await api('/rag/build', { method: 'POST', body: '{}' })
    expect(r.status).toBe(200)
    const done = await waitForStatus((s) => s['running'] === false && (s['lastResult'] as { ok: boolean })?.ok === true)
    expect((done['lastResult'] as { chunkCount: number }).chunkCount).toBe(0) // 增量：无新块
  })

  it('引用的服务商被删 → build 400（提示重选，不回落旧内联）', async () => {
    const list = await gapi('/api/rag-providers')
    const id = (list.json['ragProviders'] as Array<{ id: string }>)[0]!.id
    const del = await gapi(`/api/rag-providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    expect(del.status).toBe(200)

    const r = await api('/rag/build', { method: 'POST', body: '{}' })
    expect(r.status).toBe(400)
    expect(String(r.json['error'])).toContain('提供方不存在')
  })

  it('hh §八-11：旧版书根裸 .rag.db（未迁移）→ status 不误报未建索引，且顺手完成迁移', async () => {
    // 第二本书：书根留旧版 .rag.db（升级前现场），无 .cache——books.jsonl 每请求
    // 重读（readBooks 无缓存），中途追加登记即可被路由看到
    const LEGACY = 'RAG迁移书'
    const legacyRoot = join(workDir, LEGACY)
    mkdirSync(legacyRoot, { recursive: true })
    writeFileSync(
      join(legacyRoot, 'book.yaml'),
      `spec_version: 1\nkind: long\nbook:\n  title: ${LEGACY}\n  genre: 玄幻\nhost: cc\n`,
      'utf8',
    )
    appendFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: LEGACY, path: LEGACY, kind: 'long' }) + '\n')
    const db = new DatabaseSync(join(legacyRoot, '.rag.db'))
    createRagTables(db)
    storeChunk(db, { 章号: 1, start_offset: 0, end_offset: 42, embedding: new Float32Array([1, 0, 0]), model: 'legacy-model' })
    setRagMeta(db, 'embedding_model', 'legacy-model')
    setRagMeta(db, 'indexed_max_chapter', '3')
    db.close()

    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(LEGACY)}/rag/status`, {
      headers: { 'x-studio-token': token },
    }).then(async (x) => ({ status: x.status, json: (await x.json()) as Record<string, unknown> }))
    expect(r.status).toBe(200)
    // 旧库还在未迁移时，存在性探测走同源 helper——不得误报全零「未建索引」
    expect(r.json['chunkCount']).toBe(1)
    expect(r.json['indexedChapters']).toBe(3)
    expect(r.json['model']).toBe('legacy-model')
    // status 内 openRagDb 已完成迁移：新路径在、旧路径消失
    expect(existsSync(join(legacyRoot, '.cache', 'rag.db'))).toBe(true)
    expect(existsSync(join(legacyRoot, '.rag.db'))).toBe(false)
  })
})
