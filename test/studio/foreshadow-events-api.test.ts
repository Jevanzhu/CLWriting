/**
 * Z-P2-6 伏笔事件族接线集成测：设定/伏笔/*.md 的文档操作（保存/PATCH fm/新建/软删）
 * 经 documents API 落 foreshadow/change 事件到 workspace 会话（与 step/llm 同会话）。
 * 非伏笔文档操作零事件、userDataPath 缺失静默跳过（观测层不炸文档操作）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { computeRevision } from '../../src/document/revision.js'

const BOOK = '伏笔事件书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

/** 文件已存在时的 expectedRevision（sha256(现有内容)；不存在 → null 新建语义）。 */
function revOf(relPath: string): `sha256:${string}` | null {
  try {
    return computeRevision(join(workDir, BOOK, relPath))
  } catch {
    return null
  }
}

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
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
            /* 非 JSON 留 null */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 读 workspace 会话里的 foreshadow/change 事件（按落库序）。 */
function foreshadowEvents(): { operation: string; title: string }[] {
  const store = openSessionStore(userDataPath, join(workDir, BOOK))!
  try {
    const sid = store.workspaceSession(bookHash(join(workDir, BOOK)))
    return store
      .listEvents(bookHash(join(workDir, BOOK)), sid)
      .filter((e) => e.type === 'foreshadow/change')
      .map((e) => ({ operation: String(e.data['operation']), title: String(e.data['title']) }))
  } finally {
    store.close()
  }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-fs-ev-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-fs-ev-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 伏笔事件书\n  genre: 玄幻\nhost: cc\n',
  )
  // 清单登记：伏笔条目 doc_fs1（可写）+ 普通章 doc_ch1（对照组）
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_fs1","nodeType":"document","path":"设定/伏笔/古剑.md","parentId":null}',
      '{"id":"doc_ch1","nodeType":"document","path":"写作/正文/0001-开篇.md","parentId":null}',
    ].join('\n') + '\n',
  )
  // 伏笔初始内容（未回收）
  mkdirSync(join(bookRoot, '设定', '伏笔'), { recursive: true })
  writeFileSync(
    join(bookRoot, '设定', '伏笔', '古剑.md'),
    '---\n标题: 古剑\n状态: 未回收\n重要性: 高\n关联词: 古剑\n---\n\n主角佩剑藏机关。\n',
    'utf-8',
  )
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), '开篇。\n', 'utf-8')

  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('Z-P2-6 伏笔事件族接线', () => {
  it('非伏笔文档保存 → 零事件（对照组）', async () => {
    const r = await request('PUT', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_ch1/content`, {
      content: '开篇改。\n', expectedRevision: revOf('写作/正文/0001-开篇.md'), operationId: 'op-ch1', origin: 'manual',
    })
    expect(r.status).toBe(200)
    expect(foreshadowEvents()).toHaveLength(0)
  })

  it('伏笔保存改状态（未回收→已回收）→ foreshadow/change{complete}', async () => {
    const r = await request('PUT', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_fs1/content`, {
      content: '---\n标题: 古剑\n状态: 已回收\n重要性: 高\n关联词: 古剑\n---\n\n主角佩剑藏机关。\n',
      expectedRevision: revOf('设定/伏笔/古剑.md'), operationId: 'op-fs1', origin: 'manual',
    })
    expect(r.status).toBe(200)
    expect(foreshadowEvents()).toEqual([{ operation: 'complete', title: '古剑' }])
  })

  it('同状态保存（无变化）→ 不追加事件（差分去噪）', async () => {
    const r = await request('PUT', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_fs1/content`, {
      content: '---\n标题: 古剑\n状态: 已回收\n重要性: 高\n关联词: 古剑\n---\n\n机关已开。\n',
      expectedRevision: revOf('设定/伏笔/古剑.md'), operationId: 'op-fs2', origin: 'manual',
    })
    expect(r.status).toBe(200)
    expect(foreshadowEvents()).toHaveLength(1) // 仍只有上一条 complete
  })

  it('PATCH fm 改状态（已回收→已废弃）→ foreshadow/change{block}', async () => {
    const r = await request('PATCH', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_fs1`, {
      op: 'fm', meta: { 状态: '已废弃' },
    })
    expect(r.status).toBe(200)
    expect(foreshadowEvents()).toEqual([
      { operation: 'complete', title: '古剑' },
      { operation: 'block', title: '古剑' },
    ])
  })

  it('新建伏笔 → foreshadow/change{create}', async () => {
    const r = await request('POST', `/api/books/${encodeURIComponent(BOOK)}/documents`, {
      relPath: '设定/伏笔/玉佩.md',
      content: '---\n标题: 玉佩\n状态: 未回收\n重要性: 中\n关联词: 玉佩\n---\n\n身世信物。\n',
    })
    expect(r.status).toBe(201)
    expect(foreshadowEvents().at(-1)).toEqual({ operation: 'create', title: '玉佩' })
  })

  it('软删伏笔 → foreshadow/change{clear}', async () => {
    const r = await request('DELETE', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_fs1`)
    expect(r.status).toBe(200)
    expect(foreshadowEvents().at(-1)).toEqual({ operation: 'clear', title: '古剑' })
  })
})
