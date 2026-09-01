/**
 * D-2（二十九轮）回归：RAG 建索引失败信息绕过统一脱敏。
 *
 * startRagBuild 的 buildIndex .catch 分支此前把 e.message 直存 lastResult.error，
 * 经 GET /rag/status 明文回传——replyError 的统一脱敏闸只管非 2xx 信封，这条 200
 * 响应体的旁路漏网（embed 上游报错 message 可能夹带 URL query 凭据 / 裸 key）。
 * 修复后入库前过 redactSecret（http.ts/replyError 同源单源）。
 *
 * buildIndex 以 reject 桩（错误 message 夹带两种凭据形态），验证 lastResult.error
 * 已脱敏（不含敏感串、含 ***REDACTED***、保留「建索引异常」人话前缀）。
 * 配置走旧版内联回落（rag.secret 落 key），先例 rag-api.test.ts。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServerSafe } from '../helpers/safe-port.js'

// buildIndex 桩：reject 错误夹带两种凭据形态（query param key + 裸 sk- key）——
// 修复前两者原文明文进 lastResult.error；修复后 redactSecret 入库前清洗
vi.mock('../../src/rag/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/rag/index.js')>()
  return {
    ...orig,
    buildIndex: () =>
      Promise.reject(
        new Error('上游 embed 失败 https://api.example.com/v1/embed?api_key=sk-live-aaaaaaaaaaaaaaaa 上游返回：sk-abcdef0123456789ab'),
      ),
  }
})

const BOOK = 'R29脱敏书'
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

/** 轮询 status 直到 lastResult 就绪（后台任务收尾） */
async function waitForLastResult(timeoutMs = 4000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await api('/rag/status')
    const last = r.json['lastResult'] as Record<string, unknown> | null
    if (last) return last
    await new Promise((r2) => setTimeout(r2, 50))
  }
  throw new Error('waitForLastResult 超时')
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r29-rag-redact-'))
  userData = mkdtempSync(join(tmpdir(), 'clw-r29-rag-redact-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK}\n  genre: 玄幻\nhost: cc\n`,
    'utf8',
  )
  server = await startServerSafe({ port: 0, workDir, userDataPath: userData })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token

  // 旧版内联 RAG 配置（endpoint/model 直存 book.yaml + rag.secret 落 key）——前置校验放行
  writeFileSync(join(workDir, '.clwriting', 'rag.secret'), 'sk-legacy-key\n', 'utf8')
  const get = await api('/config')
  expect(get.status).toBe(200)
  const cfg = get.json['config'] as Record<string, unknown>
  ;(cfg as { rag: unknown })['rag'] = { enabled: true, endpoint: 'http://stub-legacy', model: 'stub-model' }
  const put = await api('/config', { method: 'PUT', body: JSON.stringify({ config: cfg }) })
  expect(put.status).toBe(200)
})

afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userData) rmSync(userData, { recursive: true, force: true })
})

describe('D-2：rag 建索引失败信息入库前脱敏', () => {
  it('buildIndex reject → lastResult.error 经 redactSecret（不含凭据串，含 REDACTED 标记）', async () => {
    const start = await api('/rag/build', { method: 'POST', body: '{}' })
    expect(start.status).toBe(200)
    expect(start.json['started']).toBe(true)

    const last = await waitForLastResult()
    expect(last['ok']).toBe(false)
    const err = String(last['error'])
    // 人话前缀保留（前端 toast 可读）
    expect(err).toContain('建索引异常')
    // 凭据串不回传：query param key 与裸 sk- key 都被清洗
    expect(err).not.toContain('aaaaaaaaaaaaaaaa')
    expect(err).not.toContain('abcdef0123456789ab')
    expect(err).toContain('***REDACTED***')
  })
})
