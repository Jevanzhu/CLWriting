/**
 * hh §八-12 错误信封统一回归：所有非 2xx JSON 错误响应唯一信封形状 {code, error}。
 * - replyError 出口单元：状态码 + content-type + 信封体三要素
 * - resolveDocEntry：docId → 清单条目；未登记 → null（调用方按 NOT_FOUND 语义回复）
 * - SSE 订阅错误路径：无工作目录 → JSON 信封（不再裸文本——前端 EventSource/fetch 可读体）
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, it, expect } from 'vitest'
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
