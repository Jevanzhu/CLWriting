/**
 * 低-3（第十轮）：PATCH /documents/:docId meta 章号整数 fail-closed（服务端兜底）。
 *
 * 旧口径 Number.isFinite 放行 3.5，updateChapterMeta rename 后文件名落成 0003.5-…，
 * 从「章号 = 整数编号」特性中脱落（前端 ChapterMetaDialog 同口径拒收，此处兜底：
 * 非正整数章号 400 BAD_INPUT，且原文件保持不动）。启动 studio server + 临时长篇书，
 * 装配方式对齐 test/studio/documents-api.test.ts。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = '章号整数测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function patchMeta(
  docId: string,
  meta: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}`,
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: baseUrl, 'x-studio-token': token },
      },
      (res) => {
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
      },
    )
    req.on('error', reject)
    req.write(JSON.stringify({ op: 'meta', ...meta }))
    req.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-meta-int-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 章号整数测试书\n  genre: 玄幻\nhost: cc\n',
  )
  writeFileSync(
    join(bookRoot, '写作', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n---\n正文。\n',
    'utf-8',
  )
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_1","nodeType":"document","path":"写作/正文/0001-开篇.md","parentId":null,"status":"draft"}',
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

describe('低-3（第十轮）：PATCH meta 章号 fail-closed 整数校验', () => {
  it('章号 3.5 → 400 BAD_INPUT，原文件不动、不生成 0003.5-…', async () => {
    const r = await patchMeta('doc_1', { 章号: 3.5 })
    expect(r.status).toBe(400)
    const j = r.json as { code?: string; error?: string }
    expect(j.code).toBe('BAD_INPUT')
    expect(j.error).toContain('正整数')

    const bookRoot = join(workDir, BOOK, '写作', '正文')
    expect(existsSync(join(bookRoot, '0001-开篇.md'))).toBe(true) // 原文件不动
    expect(existsSync(join(bookRoot, '0003.5-开篇.md'))).toBe(false) // 特性脱落文件不得产生
    const files = readFileSync(join(bookRoot, '0001-开篇.md'), 'utf-8')
    expect(files).toMatch(/章号: 1/)
  })

  it('章号 0 → 400（0 同样从章号特性脱落）', async () => {
    const r = await patchMeta('doc_1', { 章号: 0 })
    expect(r.status).toBe(400)
    expect((r.json as { code: string }).code).toBe('BAD_INPUT')
  })

  it('章号 5（正整数）→ 守卫不误伤：200 + rename 0005-开篇.md', async () => {
    const r = await patchMeta('doc_1', { 章号: 5 })
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)
    const bookRoot = join(workDir, BOOK, '写作', '正文')
    expect(existsSync(join(bookRoot, '0001-开篇.md'))).toBe(false)
    expect(readFileSync(join(bookRoot, '0005-开篇.md'), 'utf-8')).toMatch(/章号: 5/)
  })
})
