/**
 * W2A T6 —— documents API 扩展端点集成测（tree/CRUD/trash）。
 * 启动 studio server + 临时长篇书（含卷层 + 项目清单），覆盖：
 * GET /tree、POST /documents、PATCH move/rename、DELETE 软删、GET /trash、POST restore、DELETE purge、
 * 能力拒绝 403、未登记 404、无 token 403。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { __clearDocumentServices } from '../../src/studio/server/api/documents.js'

const BOOK = '文件树测试书'
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
          /* 非 JSON 留 null */
        }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** 带 token + origin 的写请求头。 */
function auth(): Record<string, string> {
  return { 'content-type': 'application/json', origin: baseUrl, 'x-studio-token': token }
}

function treePath(): string {
  return `/api/books/${encodeURIComponent(BOOK)}/tree`
}
function docPath(docId = ''): string {
  const base = `/api/books/${encodeURIComponent(BOOK)}/documents`
  return docId ? `${base}/${encodeURIComponent(docId)}` : base
}
function trashPath(id = ''): string {
  const base = `/api/books/${encodeURIComponent(BOOK)}/trash`
  return id ? `${base}/${encodeURIComponent(id)}` : base
}

beforeAll(async () => {
  __clearDocumentServices()
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-w2a-api-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '定稿', '正文', '第一卷'), { recursive: true })
  writeFileSync(join(bookRoot, '定稿', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n正文', 'utf-8')
  mkdirSync(join(bookRoot, '大纲', '卷纲'), { recursive: true })
  writeFileSync(join(bookRoot, '大纲', '卷纲', '第一卷.md'), '# 第一卷纲', 'utf-8')
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ch01","nodeType":"document","path":"定稿/正文/第一卷/0001-开篇.md","parentId":null,"status":"final"}',
    ].join('\n') + '\n',
  )
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 文件树测试书\n  genre: 玄幻\nhost: cc\n')
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false && git add -A && git commit -m init', { cwd: bookRoot, stdio: 'pipe' })

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

/** 从 tree nodes 深度查找 path。 */
function findInTree(nodes: unknown[], path: string): unknown | null {
  for (const n of nodes as Array<{ path: string; children?: unknown[] }>) {
    if (n.path === path) return n
    if (n.children) {
      const f = findInTree(n.children, path)
      if (f) return f
    }
  }
  return null
}

describe('W2A documents API', () => {
  it('GET /tree → 200 + 卷结构 + 卷纲关联 + 状态派生', async () => {
    const r = await request('GET', treePath())
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; nodes: unknown[]; revision: number }
    expect(j.ok).toBe(true)
    expect(j.revision).toBeGreaterThan(0)
    const vol = findInTree(j.nodes, '定稿/正文/第一卷') as { volumeOutlinePath?: string } | null
    expect(vol).not.toBeNull()
    expect(vol!.volumeOutlinePath).toBe('大纲/卷纲/第一卷.md')
    const chapter = findInTree(j.nodes, '定稿/正文/第一卷/0001-开篇.md') as { docId?: string; status?: string } | null
    expect(chapter).not.toBeNull()
    expect(chapter!.docId).toBe('doc_ch01')
    expect(chapter!.status).toBe('final')
  })

  it('POST /documents → 201 + 落盘 + 清单登记', async () => {
    const r = await request(
      'POST',
      docPath(),
      auth(),
      JSON.stringify({ relPath: '定稿/正文/第一卷/0002-迷雾.md', content: '---\n章号: 2\n---\n迷雾' }),
    )
    expect(r.status).toBe(201)
    const j = r.json as { ok: boolean; docId: string; path: string }
    expect(j.ok).toBe(true)
    expect(j.docId).toMatch(/^doc_/)
    expect(j.path).toBe('定稿/正文/第一卷/0002-迷雾.md')
    expect(existsSync(join(workDir, BOOK, '定稿', '正文', '第一卷', '0002-迷雾.md'))).toBe(true)
  })

  it('POST /documents 只读位置（定稿/摘要）→ 403 CAPABILITY_DENIED', async () => {
    const r = await request(
      'POST',
      docPath(),
      auth(),
      JSON.stringify({ relPath: '定稿/摘要/0001.md', content: '摘要' }),
    )
    expect(r.status).toBe(403)
    expect((r.json as { code: string }).code).toBe('CAPABILITY_DENIED')
  })

  it('POST /documents 已存在 → 409 ALREADY_EXISTS', async () => {
    const r = await request(
      'POST',
      docPath(),
      auth(),
      JSON.stringify({ relPath: '定稿/正文/第一卷/0001-开篇.md', content: 'x' }),
    )
    expect(r.status).toBe(409)
    expect((r.json as { code: string }).code).toBe('ALREADY_EXISTS')
  })

  it('PATCH move 跨卷，章号不变', async () => {
    mkdirSync(join(workDir, BOOK, '定稿', '正文', '第二卷'), { recursive: true })
    const r = await request(
      'PATCH',
      docPath('doc_ch01'),
      auth(),
      JSON.stringify({ op: 'move', toDir: '定稿/正文/第二卷' }),
    )
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; path: string }
    expect(j.ok).toBe(true)
    expect(j.path).toBe('定稿/正文/第二卷/0001-开篇.md')
    expect(existsSync(join(workDir, BOOK, '定稿', '正文', '第二卷', '0001-开篇.md'))).toBe(true)
  })

  it('PATCH 未登记 docId → 404 NOT_FOUND', async () => {
    const r = await request(
      'PATCH',
      docPath('doc_unknown'),
      auth(),
      JSON.stringify({ op: 'move', toDir: '定稿/正文/第二卷' }),
    )
    expect(r.status).toBe(404)
    expect((r.json as { code: string }).code).toBe('NOT_FOUND')
  })

  it('DELETE 软删 → 回收站；GET /trash 可见；POST restore 恢复；DELETE purge 永久删', async () => {
    // 先新建一个独立 doc 走完整回收站往返
    const created = await request(
      'POST',
      docPath(),
      auth(),
      JSON.stringify({ relPath: '素材/灵感.md', content: '---\n---\n灵感' }),
    )
    const docId = (created.json as { docId: string }).docId

    // 软删
    const del = await request('DELETE', docPath(docId), auth())
    expect(del.status).toBe(200)
    expect((del.json as { trashedPath: string }).trashedPath).toContain('工作区/.trash/')

    // 回收站可见
    const trashList = await request('GET', trashPath(), auth())
    expect(trashList.status).toBe(200)
    const entries = (trashList.json as { entries: Array<{ id: string }> }).entries
    expect(entries.some((e) => e.id === docId)).toBe(true)

    // 恢复
    const restore = await request('POST', `${trashPath(docId)}/restore`, auth())
    expect(restore.status).toBe(200)
    expect((restore.json as { path: string }).path).toBe('素材/灵感.md')
    expect(existsSync(join(workDir, BOOK, '素材', '灵感.md'))).toBe(true)

    // 再次软删后永久删
    await request('DELETE', docPath(docId), auth())
    const purge = await request('DELETE', trashPath(docId), auth())
    expect(purge.status).toBe(200)
    expect(existsSync(join(workDir, BOOK, '工作区', '.trash'))).toBe(true) // .trash 目录还在
  })

  it('无 token 的写请求 → 403', async () => {
    const r = await request(
      'POST',
      docPath(),
      { 'content-type': 'application/json', origin: baseUrl },
      JSON.stringify({ relPath: '素材/无token.md', content: 'x' }),
    )
    expect(r.status).toBe(403)
  })
})
