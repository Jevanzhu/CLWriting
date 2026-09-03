/**
 * R43-24（四十三轮）：rewrite / outline 端点 code 透传 + 状态码映射回归。
 *
 * 修复前：runRewriter/runOutline 失败一律坍缩 500 'GEN_FAIL'，NO_PROVIDER 等
 * 配置缺失族的成因被掩蔽。修复后按 TaskCode 映射：
 * - NO_* 族（NO_USERDATA/NO_PROVIDER/NO_MODEL）→ 400（客户端可处置：配供应商/档位）
 * - ABORTED（用户中断）→ 499（请求被取消语义；api/ 无既有先例，错误信封形状不变）
 * - 其余（GEN_FAIL/TIMEOUT_TOTAL/EMPTY_OUTPUT…）→ 500 + 透传 code
 * 错误文案一律不变。runSpec 经 vi.mock 注入受控失败封套（不依赖真实 provider 配置）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

// vi.hoisted：mock 工厂随 vi.mock 提升执行，runSpecMock 必须同期可访问
const runSpecMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/ai/tasks/spec.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/tasks/spec.js')>()
  return { ...orig, runSpec: runSpecMock as unknown as typeof orig.runSpec }
})

const BOOK = 'R43改写码透传书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let chapterDocId = ''
const prevDriver = process.env['CLWRITING_DRIVER']

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
        res.on('data', (c) => (data += c.toString('utf8')))
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
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r43-rewrite-code-'))
  const userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-r43-rewrite-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: R43改写码透传书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  writeFileSync(
    join(bookRoot, '写作', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n这是正文内容，主角登场。\n',
    'utf8',
  )
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  chapterDocId = generateDocId()
  upsertEntry(m, { id: chapterDocId, nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)

  server = await startServerSafe({ port: 0, workDir, userDataPath })
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

const NO_PROVIDER_ERR = '未配置 AI 服务供应商。请在设置 → AI 中添加并启用。'

describe('R43-24: POST /documents/:docId/rewrite——TaskCode 透传映射', () => {
  it('NO_PROVIDER → 400 + code NO_PROVIDER（修复前 500 GEN_FAIL 掩蔽成因）', async () => {
    runSpecMock.mockResolvedValueOnce({ ok: false, code: 'NO_PROVIDER', error: NO_PROVIDER_ERR })
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/rewrite`, {
      instruction: '更生动',
    })
    expect(r.status).toBe(400)
    const j = r.json as { code: string; error: string }
    expect(j.code).toBe('NO_PROVIDER')
    expect(j.error).toBe(NO_PROVIDER_ERR)
  })

  it('ABORTED（用户中断）→ 499 + code ABORTED（请求被取消语义，信封形状不变）', async () => {
    runSpecMock.mockResolvedValueOnce({ ok: false, code: 'ABORTED', error: '已中断' })
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/rewrite`, {
      instruction: '更生动',
    })
    expect(r.status).toBe(499)
    const j = r.json as { code: string; error: string }
    expect(j.code).toBe('ABORTED')
    expect(j.error).toBe('已中断')
  })

  it('GEN_FAIL → 维持 500 + 透传 code GEN_FAIL（文案不变）', async () => {
    runSpecMock.mockResolvedValueOnce({ ok: false, code: 'GEN_FAIL', error: '生成失败样例' })
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/rewrite`, {
      instruction: '更生动',
    })
    expect(r.status).toBe(500)
    const j = r.json as { code: string; error: string }
    expect(j.code).toBe('GEN_FAIL')
    expect(j.error).toBe('生成失败样例')
  })
})

describe('R43-24: POST /books/:name/outline——同款映射', () => {
  it('NO_PROVIDER → 400 + code NO_PROVIDER（修复前 500 GEN_FAIL 掩蔽成因）', async () => {
    runSpecMock.mockResolvedValueOnce({ ok: false, code: 'NO_PROVIDER', error: NO_PROVIDER_ERR })
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 1 })
    expect(r.status).toBe(400)
    const j = r.json as { code: string; error: string }
    expect(j.code).toBe('NO_PROVIDER')
    expect(j.error).toBe(NO_PROVIDER_ERR)
  })
})
