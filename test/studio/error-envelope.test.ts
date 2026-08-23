/**
 * hh §八-12 错误信封统一回归：所有非 2xx JSON 错误响应唯一信封形状 {code, error}。
 * - replyError 出口单元：状态码 + content-type + 信封体三要素
 * - resolveDocEntry：docId → 清单条目；未登记 → null（调用方按 NOT_FOUND 语义回复）
 * - SSE 订阅错误路径：无工作目录 → JSON 信封（不再裸文本——前端 EventSource/fetch 可读体）
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import type { ServerResponse } from 'node:http'
import { replyError } from '../../src/studio/server/http.js'
import { resolveDocEntry } from '../../src/studio/server/book-context.js'
import { startServer } from '../../src/studio/server/index.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

let server: http.Server | undefined
let baseUrl = ''

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
})

describe('replyError 统一信封单元', () => {
  it('状态码 + JSON content-type + {code, error} 体三要素', () => {
    const calls: Array<{ status: number; headers: Record<string, string>; body: string }> = []
    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        calls.push({ status, headers, body: '' })
      },
      end(body: string) {
        calls[0]!.body = body
      },
    } as unknown as ServerResponse
    replyError(res, 409, 'BUSY', '本书正在生成')
    expect(calls[0]!.status).toBe(409)
    expect(calls[0]!.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(JSON.parse(calls[0]!.body)).toEqual({ code: 'BUSY', error: '本书正在生成' })
  })
})

describe('resolveDocEntry（hh §八-12 docId 样板公共化）', () => {
  it('已登记 → 返回条目；未登记 → null', () => {
    const bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-envelope-'))
    try {
      mkdirSync(join(bookRoot, '项目'), { recursive: true })
      const docId = generateDocId()
      const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
      upsertEntry(m, { id: docId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null })
      writeManifest(join(bookRoot, '项目', '文档清单.jsonl'), m)

      expect(resolveDocEntry(bookRoot, docId)?.path).toBe('定稿/正文/0001-开篇.md')
      expect(resolveDocEntry(bookRoot, 'doc_unknown0000000000000000')).toBeNull()
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })
})

describe('SSE 错误路径走 JSON 信封（不再裸文本）', () => {
  it('无工作目录 → 400 {code: NO_WORKDIR}（fetch 可读体判别）', async () => {
    server = startServer({ port: 0, workDir: null })
    await new Promise<void>((r) => server!.once('listening', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const resp = await fetch(`${baseUrl}/api/books/任意书/stream`)
    expect(resp.status).toBe(400)
    expect(resp.headers.get('content-type')).toContain('application/json')
    expect(await resp.json()).toEqual({ code: 'NO_WORKDIR', error: '未定位到工作目录' })
  })
})

// Q-7（第十五轮）：documents 六端点（create/patch/copy/delete/trash-restore/trash-purge）
// 结构化失败原裸 result 整体回复（前端 toast 直显机器码，reason 人话永不见）——收编
// replyError 统一信封 {code, error=reason} 后的回归锚定
describe('documents 端点结构化失败走统一信封（Q-7）', () => {
  const BOOK = '信封测试书'
  let docServer: http.Server | undefined
  let docBaseUrl = ''
  let token = ''

  beforeAll(async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'clwriting-envelope-doc-'))
    mkdirSync(join(workDir, '.clwriting'), { recursive: true })
    writeFileSync(
      join(workDir, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
    )
    const bookRoot = join(workDir, BOOK)
    mkdirSync(join(bookRoot, '项目'), { recursive: true })
    writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 信封测试书\n  genre: 玄幻\nhost: cc\n')
    // 登记一个真实文档（磁盘文件真实存在——create 撞它测 ALREADY_EXISTS。
    // 注意用 写作/ 树：启动迁移（migrateFinalizedRevisions）会把未定稿书的 定稿/ 文件挪回 写作/）
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), '# 开篇\n\n正文\n')
    const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
    upsertEntry(m, { id: 'doc_env1', nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
    writeManifest(join(bookRoot, '项目', '文档清单.jsonl'), m)

    docServer = startServer({ port: 0, workDir })
    await new Promise<void>((r) => docServer!.once('listening', r))
    docBaseUrl = `http://127.0.0.1:${(docServer.address() as AddressInfo).port}`
    const r = await fetch(`${docBaseUrl}/api/boot`)
    token = ((await r.json()) as { token: string }).token
  })

  afterAll(async () => {
    if (docServer) await new Promise<void>((r) => docServer!.close(() => r()))
  })

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${docBaseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-studio-token': token, origin: docBaseUrl },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  it('create 撞已存在文件 → 409 {code: ALREADY_EXISTS, error: 人话 reason}', async () => {
    const resp = await call('POST', `/api/books/${encodeURIComponent(BOOK)}/documents`, { relPath: '写作/正文/0001-开篇.md' })
    expect(resp.status).toBe(409)
    expect(resp.headers.get('content-type')).toContain('application/json')
    const j = (await resp.json()) as Record<string, unknown>
    expect(j['code']).toBe('ALREADY_EXISTS')
    expect(typeof j['error']).toBe('string')
    expect(j['error']).toContain('已存在')
  })

  it('patch 未知 docId → 404 {code: NOT_FOUND, error: reason}（信封而非裸 result）', async () => {
    const resp = await call('PATCH', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_unknown000000000000`, { op: 'rename', newName: '改名' })
    expect(resp.status).toBe(404)
    const j = (await resp.json()) as Record<string, unknown>
    expect(j['code']).toBe('NOT_FOUND')
    expect(typeof j['error']).toBe('string')
    expect('ok' in j).toBe(false) // 旧裸 result 形状（ok:false + reason）不得回潮
  })

  it('copy 未知 docId → 404 信封', async () => {
    const resp = await call('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_unknown000000000000/copy`, { relPath: '写作/正文/0002-副本.md' })
    expect(resp.status).toBe(404)
    expect(((await resp.json()) as Record<string, unknown>)['code']).toBe('NOT_FOUND')
  })

  it('delete 未知 docId → 404 信封', async () => {
    const resp = await call('DELETE', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_unknown000000000000`)
    expect(resp.status).toBe(404)
    expect(((await resp.json()) as Record<string, unknown>)['code']).toBe('NOT_FOUND')
  })

  it('trash restore / purge 未知条目 → 404 信封', async () => {
    const r1 = await call('POST', `/api/books/${encodeURIComponent(BOOK)}/trash/no-such-entry/restore`)
    expect(r1.status).toBe(404)
    expect(((await r1.json()) as Record<string, unknown>)['code']).toBe('NOT_FOUND')

    const r2 = await call('DELETE', `/api/books/${encodeURIComponent(BOOK)}/trash/no-such-entry`)
    expect(r2.status).toBe(404)
    expect(((await r2.json()) as Record<string, unknown>)['code']).toBe('NOT_FOUND')
  })
})
