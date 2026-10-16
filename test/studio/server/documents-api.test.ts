/**
 * PUT /documents/:docId/content 端点集成测（W1 T9）：
 * 启动 studio server + 临时长篇书（含项目清单登记 docId→path），
 * 验证保存主路径 + 冲突 409 + 未登记 404 + 只读 403 + 缺字段 400。
 */
import http from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../../helpers/studio-server.js'
import { readManifest, writeManifest, upsertEntry } from '../../../src/document/manifest.js'

const BOOK = '保存测试书'
let studio: StudioHarness

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = '',
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(studio.baseUrl)
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
    { 'content-type': 'application/json', origin: studio.baseUrl, 'x-studio-token': studio.token },
    JSON.stringify(body),
  )
}

function patchMeta(docId: string, meta: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  return request(
    'PATCH',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}`,
    { 'content-type': 'application/json', 'x-studio-token': studio.token },
    JSON.stringify({ op: 'meta', ...meta }),
  )
}

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-docs-',
    // 项目清单：登记 doc_1（可写定稿章）+ doc_ro（只读摘要）——随起服前置盘
    dirs: ['项目'],
    files: [
      {
        rel: '项目/文档清单.jsonl',
        content:
          [
            '{"version":1,"type":"header"}',
            '{"id":"doc_1","nodeType":"document","path":"定稿/正文/0001-开篇.md","parentId":null,"status":"draft"}',
            '{"id":"doc_ro","nodeType":"document","path":"定稿/摘要/0001.md","parentId":null}',
          ].join('\n') + '\n',
      },
    ],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 保存测试书\n  genre: 玄幻\nhost: cc\n',
  })
})

afterAll(() => studio.close())

describe('PUT /documents/:docId/content（W1 保存端点）', () => {
  it('新建保存（清单登记 + expectedRevision=null）→ 200 + 落盘', async () => {
    const r = await put('doc_1', {
      content: '你好',
      expectedRevision: null,
      operationId: 'op1',
      origin: 'manual',
    })
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; revision: string; superseded: boolean }
    expect(j.ok).toBe(true)
    expect(j.revision).toMatch(/^sha256:/)
    expect(readFileSync(join(studio.bookRoot, '写作/正文/0001-开篇.md'), 'utf-8')).toBe('你好')
  })

  it('expectedRevision 不符磁盘 → 409', async () => {
    const r = await put('doc_1', {
      content: '再次',
      expectedRevision: 'sha256:deadbeef',
      operationId: 'op2',
      origin: 'manual',
    })
    expect(r.status).toBe(409)
    expect((r.json as { code: string }).code).toBe('REVISION_CONFLICT')
    // CC-P2-11：错误信封统一 {error, code?}——code 保留（doc store 冲突双出路机器码），
    // 人话进 error，不再有 ok:false 冗余位
    expect(typeof (r.json as { error: string }).error).toBe('string')
    expect((r.json as Record<string, unknown>).ok).toBeUndefined()
  })

  it('docId 未在清单登记 → 404', async () => {
    const r = await put('doc_unknown', {
      content: 'x',
      expectedRevision: null,
      operationId: 'op3',
      origin: 'manual',
    })
    expect(r.status).toBe(404)
  })

  it('只读文档（定稿/摘要）→ 403 CAPABILITY_DENIED', async () => {
    const r = await put('doc_ro', {
      content: 'x',
      expectedRevision: null,
      operationId: 'op4',
      origin: 'manual',
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
      { 'content-type': 'application/json', origin: studio.baseUrl },
      JSON.stringify({ content: 'x', expectedRevision: null, operationId: 'op6', origin: 'manual' }),
    )
    expect(r.status).toBe(403)
  })
})

describe('PATCH /documents/:docId meta（章号）', () => {
  it('长篇改章号 → 章号变 + 文件名 rename（曾因 numKey 丢弃静默失败）', async () => {
    const bodyDir = join(studio.bookRoot, '写作', '正文')
    mkdirSync(bodyDir, { recursive: true })
    const oldPath = join(bodyDir, '0001-开篇.md')
    writeFileSync(oldPath, '---\n章号: 1\n标题: 开篇\n---\n正文。\n', 'utf-8')

    const r = await patchMeta('doc_1', { 章号: 5 })
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)

    // 文件名 rename：0001-开篇.md → 0005-开篇.md（修复前章号被忽略 → service 不 rename → 不 rename）
    expect(existsSync(oldPath)).toBe(false)
    const newPath = join(bodyDir, '0005-开篇.md')
    expect(existsSync(newPath)).toBe(true)
    expect(readFileSync(newPath, 'utf-8')).toMatch(/章号: 5/)
  })
})

// ── ee-P1-3：定稿防吃书闸 API 层（LEAD_GATE → 409 + error 信封） ────────────

describe('POST /documents/:docId/finalize（ee-P1-3 防吃书闸）', () => {
  it('声明了没做 → 409 + code LEAD_GATE + error 人话透传，manifest 基线未写', async () => {
    const bookRoot = studio.bookRoot
    // 装配闸门触发条件：正文章 + 布线悬念线 + 细纲声明推进（账本推进.md 缺失 → 未兑现）
    writeFileSync(
      join(bookRoot, '写作', '正文', '0009-闸门章.md'),
      '---\n章号: 9\n标题: 闸门章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n玉佩在火光里泛出微芒。\n',
      'utf-8',
    )
    mkdirSync(join(bookRoot, '布线', '悬念'), { recursive: true })
    writeFileSync(
      join(bookRoot, '布线', '悬念', '悬念-001-玉佩.md'),
      '---\n编号: 悬念-001\n标题: 玉佩\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
      'utf-8',
    )
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    writeFileSync(join(bookRoot, '工作区', '细纲.md'), '---\n章号: 9\n推进: 悬念-001\n---\n\n本章细纲。\n', 'utf-8')
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    upsertEntry(m, { id: 'doc_gate', nodeType: 'document', path: '写作/正文/0009-闸门章.md', parentId: null })
    writeManifest(manifestPath, m)

    const r = await request('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_gate/finalize`, {
      'x-studio-token': studio.token,
    })
    expect(r.status).toBe(409)
    // N-2（第十二轮）：finalize 错误信封收编 replyError——{code,error} 无 ok 冗余位
    const j = r.json as { code: string; error: string }
    expect(j).not.toHaveProperty('ok')
    expect(j.code).toBe('LEAD_GATE')
    expect(j.error).toContain('悬念-001')
    expect(j.error).toContain('声明了没做')
    // 定稿未生效：manifest 无定稿基线
    const e = readManifest(manifestPath).entries.get('doc_gate')!
    expect(e.finalizedRevision).toBeUndefined()
  })
})

// ── 书架摘要缓存失效（文档级写出口）──────────────────────────
// 书架摘要是 30s TTL 结果缓存（progress.ts summaryCache，键 = bookRoot）。文档级写操作
// 成功后须即时失效该缓存，否则写后在 30s 窗口内 GET /api/books 仍回旧章数/字数。
// 改书名/删书路径（books-rename.ts / books-lifecycle.ts）已失效，此处锚文档 CRUD 出口。

describe('书架摘要缓存失效（文档级写出口）', () => {
  async function shelf(): Promise<{ chapters: number; words: number }> {
    const r = await request('GET', '/api/books', { origin: studio.baseUrl, 'x-studio-token': studio.token })
    expect(r.status).toBe(200)
    const b = (r.json as { books: Array<{ name: string; chapters: number; words: number }> }).books.find(
      (x) => x.name === BOOK,
    )
    expect(b).toBeDefined()
    return { chapters: b!.chapters, words: b!.words }
  }

  // 正文章须带 章号 front matter（readChapter 缺 章号 即 !ok，不计入摘要章数）——
  // 内容形如 章号-标题.md 的正式章，让 GET /api/books 摘要扫描能反映增删。
  async function createChapter(relPath: string, no: number, title: string): Promise<string> {
    const content = `---\n章号: ${no}\n标题: ${title}\n---\n\n一二三四五六七八九十\n`
    const r = await request(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents`,
      { 'content-type': 'application/json', origin: studio.baseUrl, 'x-studio-token': studio.token },
      JSON.stringify({ relPath, content }),
    )
    expect(r.status).toBe(201)
    return (r.json as { docId: string }).docId
  }

  it('新建章节 → 写后立即读书架，章数/字数已更新（不等 30s TTL）', async () => {
    const before = await shelf() // 首读：摘要入 30s 缓存
    await createChapter('写作/正文/0088-摘要失效新章.md', 88, '摘要失效新章')
    const after = await shelf() // 紧接写后读：失效未补则均回旧值（红）
    expect(after.chapters).toBe(before.chapters + 1)
    expect(after.words).toBeGreaterThan(before.words)
  })

  it('复制章节 → 写后立即读书架，章数 +1', async () => {
    const docId = await createChapter('写作/正文/0089-待复制.md', 89, '待复制')
    const before = await shelf()
    const r = await request(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}/copy`,
      { 'content-type': 'application/json', origin: studio.baseUrl, 'x-studio-token': studio.token },
      JSON.stringify({ relPath: '写作/正文/0090-副本.md' }),
    )
    expect(r.status).toBe(201)
    const after = await shelf()
    expect(after.chapters).toBe(before.chapters + 1)
  })

  it('软删章节 → 写后立即读书架，章数 -1；回收站恢复 → 章数 +1', async () => {
    const docId = await createChapter('写作/正文/0091-待删.md', 91, '待删')
    const beforeDelete = await shelf()
    const del = await request(
      'DELETE',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}`,
      { origin: studio.baseUrl, 'x-studio-token': studio.token },
    )
    expect(del.status).toBe(200)
    const afterDelete = await shelf()
    expect(afterDelete.chapters).toBe(beforeDelete.chapters - 1)

    const trash = await request('GET', `/api/books/${encodeURIComponent(BOOK)}/trash`, {
      origin: studio.baseUrl,
      'x-studio-token': studio.token,
    })
    const entries = (trash.json as { entries: Array<{ id: string }> }).entries
    const id = entries[entries.length - 1]!.id
    const restore = await request(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/trash/${encodeURIComponent(id)}/restore`,
      { origin: studio.baseUrl, 'x-studio-token': studio.token },
    )
    expect(restore.status).toBe(200)
    const afterRestore = await shelf()
    expect(afterRestore.chapters).toBe(beforeDelete.chapters)
  })
})
