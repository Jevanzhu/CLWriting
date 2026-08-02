/**
 * PUT /documents/:docId/content 端点集成测（W1 T9）：
 * 启动 studio server + 临时长篇书（含项目清单登记 docId→path），
 * 验证保存主路径 + 冲突 409 + 未登记 404 + 只读 403 + 缺字段 400。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = '保存测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = '',
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c.toString('utf-8')))
      res.on('end', () => {
        let json: unknown = null
        try {
          json = JSON.parse(data)
        } catch {
          /* 非 JSON 响应留 null */
        }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function put(docId: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  return request(
    'PUT',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}/content`,
    { 'content-type': 'application/json', origin: baseUrl, 'x-studio-token': token },
    JSON.stringify(body),
  )
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-docs-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 保存测试书\n  genre: 玄幻\nhost: cc\n',
  )
  // 项目清单：登记 doc_1（可写定稿章）+ doc_ro（只读摘要）
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_1","nodeType":"document","path":"定稿/正文/0001-开篇.md","parentId":null,"status":"draft"}',
      '{"id":"doc_ro","nodeType":"document","path":"定稿/摘要/0001.md","parentId":null}',
    ].join('\n') + '\n',
  )
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('PUT /documents/:docId/content（W1 保存端点）', () => {
  it('新建保存（清单登记 + expectedRevision=null）→ 200 + 落盘', async () => {
    const r = await put('doc_1', {
      content: '你好', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; revision: string; superseded: boolean }
    expect(j.ok).toBe(true)
    expect(j.revision).toMatch(/^sha256:/)
    expect(readFileSync(join(workDir, BOOK, '定稿/正文/0001-开篇.md'), 'utf-8')).toBe('你好')
  })

  it('expectedRevision 不符磁盘 → 409', async () => {
    const r = await put('doc_1', {
      content: '再次', expectedRevision: 'sha256:deadbeef', operationId: 'op2', origin: 'manual',
    })
    expect(r.status).toBe(409)
    expect((r.json as { code: string }).code).toBe('REVISION_CONFLICT')
  })

  it('docId 未在清单登记 → 404', async () => {
    const r = await put('doc_unknown', {
      content: 'x', expectedRevision: null, operationId: 'op3', origin: 'manual',
    })
    expect(r.status).toBe(404)
  })

  it('只读文档（定稿/摘要）→ 403 CAPABILITY_DENIED', async () => {
    const r = await put('doc_ro', {
      content: 'x', expectedRevision: null, operationId: 'op4', origin: 'manual',
    })
    expect(r.status).toBe(403)
    expect((r.json as { code: string }).code).toBe('CAPABILITY_DENIED')
  })

  it('缺 content → 400', async () => {
    const r = await put('doc_1', { expectedRevision: null, operationId: 'op5' })
    expect(r.status).toBe(400)
  })

  it('无 token → 403（写端点 defense-in-depth）', async () => {
    const r = await request(
      'PUT',
      `/api/books/${encodeURIComponent(BOOK)}/documents/doc_1/content`,
      { 'content-type': 'application/json', origin: baseUrl },
      JSON.stringify({ content: 'x', expectedRevision: null, operationId: 'op6', origin: 'manual' }),
    )
    expect(r.status).toBe(403)
  })
})
