/**
 * POST /api/books/:name/documents/:docId/rewrite 改写直读端点集成测（M12 块2 B2.1）。
 * mock driver（writer role）下验证：local 选段改写 / whole 整章改写 / append 续写（M2）→ diff 有变化。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { appendRewritten, buildAppendPrompt } from '../../src/studio/server/api/rewrite.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const BOOK = '改写测试书'
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
        res.on('data', (c) => (data += c.toString('utf-8')))
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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-rewrite-doc-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '定稿', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 改写测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf8',
  )
  writeFileSync(
    join(bookRoot, '定稿', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n这是正文内容，主角登场。\n',
    'utf8',
  )
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  chapterDocId = generateDocId()
  upsertEntry(m, { id: chapterDocId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
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

describe('POST /documents/:docId/rewrite 改写直读（M12 B2.1）', () => {
  it('local 选段改写 → 200 + diff 有 add 行', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/rewrite`, {
      instruction: '更生动',
      selection: '主角登场',
    })
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; mode: string; original: string; rewritten: string; diff: { type: string }[] }
    expect(j.ok).toBe(true)
    expect(j.mode).toBe('local')
    expect(j.rewritten).not.toBe(j.original)
    expect(j.diff.some((d) => d.type === 'add')).toBe(true)
    expect(j.diff.some((d) => d.type === 'del')).toBe(true)
  })

  it('whole 整章改写（无 selection）→ 200 + mode=whole', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/rewrite`, {
      instruction: '重写整章',
    })
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; mode: string; original: string; rewritten: string; diff: { type: string }[] }
    expect(j.ok).toBe(true)
    expect(j.mode).toBe('whole')
    expect(j.rewritten).not.toBe(j.original ?? '')
    expect(j.diff.length).toBeGreaterThan(0)
  })

  it('append 续写（无 selection + append:true）→ 200 + 原文全保留 + diff 纯新增', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/rewrite`, {
      instruction: '继续写下去',
      append: true,
    })
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; mode: string; original: string; rewritten: string; diff: { type: string }[] }
    expect(j.ok).toBe(true)
    expect(j.mode).toBe('append')
    // 原文（去尾换行）完整保留在开头，续写只追加
    expect(j.rewritten.startsWith(j.original.replace(/\n+$/, ''))).toBe(true)
    expect(j.rewritten.length).toBeGreaterThan(j.original.length)
    expect(j.diff.some((d) => d.type === 'add')).toBe(true)
    expect(j.diff.some((d) => d.type === 'del')).toBe(false)
  })

  it('缺 instruction → 400', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/rewrite`, { selection: 'x' })
    expect(r.status).toBe(400)
  })
})

describe('append 纯函数（M2 续写解选区）', () => {
  it('appendRewritten：原文去尾换行 + 空行 + 续写', () => {
    expect(appendRewritten('第一段。\n', '第二段。')).toBe('第一段。\n\n第二段。')
    expect(appendRewritten('第一段。', '第二段。')).toBe('第一段。\n\n第二段。')
  })

  it('appendRewritten：空白页直接用续写（无前导空行）', () => {
    expect(appendRewritten('', '开篇文字。')).toBe('开篇文字。')
  })

  it('buildAppendPrompt：全文作语境 + 明示只输出续写部分', () => {
    const p = buildAppendPrompt('他推门进来。', '续写200字')
    expect(p).toContain('他推门进来。')
    expect(p).toContain('续写200字')
    expect(p).toContain('只输出续写部分')
  })

  it('buildAppendPrompt：空白页语境给从头开写提示', () => {
    expect(buildAppendPrompt('', '开写')).toContain('本章尚无正文')
  })
})
