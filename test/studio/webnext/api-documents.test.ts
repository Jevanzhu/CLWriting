/**
 * T2-6 · api/documents.ts 行为级护栏（走真实 client + 桩 fetch，断言行为非实现）。
 *
 * 覆盖：读/写端点的 URL 编码、method、body 负载（乐观锁字段），写方法 token 注入；
 * 409 REVISION_CONFLICT 以 ApiError 透出（doc store 的冲突出路依赖此口径）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getContent,
  putContent,
  saveContent,
  createDoc,
  deleteDoc,
  finalizeDoc,
  getContentRevisioned,
  copyDoc,
  renameDoc,
  moveDoc,
  updateChapterMetaDoc,
  updateDocMeta,
  batchFinalizeDocs,
  listTrash,
  restoreTrash,
  purgeTrash,
} from '../../../src/studio/web-next/src/api/documents'
import { boot, ApiError } from '../../../src/studio/web-next/src/api/client'

interface Call { url: string; init: RequestInit | undefined }

let calls: Call[] = []
function stubFetch(responder: (c: Call) => Response): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const c = { url: String(input), init }
      calls.push(c)
      return responder(c)
    }),
  )
}

beforeEach(async () => {
  // 先 boot 拿 token（模块级，文件内后续请求都带 T-doc）
  stubFetch(() => new Response(JSON.stringify({ token: 'T-doc' }), { status: 200 }))
  await boot()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('documents api · 读', () => {
  it('getContent：GET 路径寻址（书名/文件路径均编码）+ 返回 content', async () => {
    stubFetch(() => ok({ content: '正文' }))
    const r = await getContent('书 A', '写作/正文/第1章 x.md')
    expect(r).toBe('正文')
    expect(calls[0]!.init?.method).toBe('GET') // 缺省 GET（client 显式 resolve 为 GET）
    expect(calls[0]!.url).toBe(
      `/api/books/${encodeURIComponent('书 A')}/file?file=${encodeURIComponent('写作/正文/第1章 x.md')}`,
    )
  })

  it('契约①：GET 读同样带 x-studio-token 头', async () => {
    stubFetch(() => ok({ content: 'x' }))
    await getContent('书A', 'a.md')
    expect(new Headers(calls[0]!.init?.headers).get('x-studio-token')).toBe('T-doc')
  })
})

describe('documents api · 写', () => {
  it('saveContent：PUT 乐观锁负载（content/expectedRevision/operationId/origin）+ token 头', async () => {
    stubFetch(() => ok({ ok: true, revision: 'sha256:abc', superseded: false }))
    const r = await saveContent('书A', 'd1', {
      content: '新内容',
      expectedRevision: 'sha256:old',
      operationId: 'op-1',
      origin: 'manual',
    })
    expect(r.revision).toBe('sha256:abc')
    const c = calls[0]!
    expect(c.init?.method).toBe('PUT')
    expect(c.url).toBe('/api/books/%E4%B9%A6A/documents/d1/content')
    expect(new Headers(c.init?.headers).get('x-studio-token')).toBe('T-doc')
    expect(JSON.parse(String(c.init?.body))).toEqual({
      content: '新内容',
      expectedRevision: 'sha256:old',
      operationId: 'op-1',
      origin: 'manual',
    })
  })

  it('saveContent 409 冲突 → 抛 ApiError{code:REVISION_CONFLICT}（doc store 冲突出路依赖）', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ code: 'REVISION_CONFLICT', error: '版本冲突' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const err = await saveContent('书A', 'd1', {
      content: 'x',
      expectedRevision: null,
      operationId: 'op',
    }).then(
      () => { throw new Error('应抛出') },
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('REVISION_CONFLICT')
  })

  it('putContent：可选 expectedRevision——传入才进 body（乐观锁可选语义）', async () => {
    stubFetch(() => ok({ ok: true, revision: 'sha256:1' }))
    await putContent('书A', '文风/文风铁律.md', '内容')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ content: '内容' })
    await putContent('书A', '文风/文风铁律.md', '内容2', 'sha256:base')
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      content: '内容2',
      expectedRevision: 'sha256:base',
    })
  })

  it('createDoc / deleteDoc / finalizeDoc：method 与 URL 口径', async () => {
    stubFetch(() => ok({ ok: true, docId: 'n1', path: 'p', revision: 'sha256:1' }))
    await createDoc('书A', { relPath: '卷1/第1章.md', content: 'x' })
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.url).toBe('/api/books/%E4%B9%A6A/documents')

    stubFetch(() => ok({ ok: true }))
    await deleteDoc('书A', 'd1')
    expect(calls[0]!.init?.method).toBe('DELETE')
    expect(calls[0]!.url).toBe('/api/books/%E4%B9%A6A/documents/d1')

    stubFetch(() => ok({ ok: true, status: 'final', skipped: false }))
    await finalizeDoc('书A', 'd1')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.url).toBe('/api/books/%E4%B9%A6A/documents/d1/finalize')
  })
})

describe('documents api · 树 CRUD 与批量定稿（X-6 补缺）', () => {
  it('getContentRevisioned：与 getContent 同 URL，返回 content + revision 指纹', async () => {
    stubFetch(() => ok({ content: '正文', revision: 'sha256:1' }))
    const r = await getContentRevisioned('书A', 'a.md')
    expect(r).toEqual({ content: '正文', revision: 'sha256:1' })
    expect(calls[0]!.url).toBe(`/api/books/${encodeURIComponent('书A')}/file?file=a.md`)
  })

  it('copyDoc：POST /copy，body 只带 relPath（源 docId 走 URL）', async () => {
    stubFetch(() => ok({ ok: true, docId: 'n2', path: '卷1/第1章 副本.md', revision: 'sha256:2' }))
    await copyDoc('书A', 'd1', '卷1/第1章 副本.md')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.url).toBe(`/api/books/${encodeURIComponent('书A')}/documents/d1/copy`)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ relPath: '卷1/第1章 副本.md' })
  })

  it('renameDoc / moveDoc：PATCH op 口径（rename→newName / move→toDir）', async () => {
    stubFetch(() => ok({ ok: true }))
    await renameDoc('书A', 'd1', '新章名')
    expect(calls[0]!.init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ op: 'rename', newName: '新章名' })

    await moveDoc('书A', 'd1', '卷2')
    expect(calls[1]!.init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ op: 'move', toDir: '卷2' })
  })

  it('updateChapterMetaDoc / updateDocMeta：meta 展开 vs fm 嵌套两种负载形态', async () => {
    stubFetch(() => ok({ ok: true }))
    await updateChapterMetaDoc('书A', 'd1', { 标题: '新标题', 章号: 3 })
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ op: 'meta', 标题: '新标题', 章号: 3 })

    await updateDocMeta('书A', 'd1', { 标签: ['伏笔'] })
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ op: 'fm', meta: { 标签: ['伏笔'] } })
  })

  it('batchFinalizeDocs：POST batch-finalize，body 只带 docIds 数组', async () => {
    stubFetch(() => ok({ ok: true, results: [{ docId: 'd1', ok: true }, { docId: 'd2', ok: false, error: 'x' }] }))
    const r = await batchFinalizeDocs('书A', ['d1', 'd2'])
    expect(calls[0]!.url).toBe(`/api/books/${encodeURIComponent('书A')}/documents/batch-finalize`)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ docIds: ['d1', 'd2'] })
    expect(r.results).toHaveLength(2)
  })
})

describe('documents api · 回收站（X-6 补缺）', () => {
  it('listTrash：GET /trash 取 entries；服务端无 entries 字段 → 空数组兜底', async () => {
    stubFetch(() => ok({ entries: [{ id: 't1', path: 'a.md' }] }))
    const r = await listTrash('书A')
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.url).toBe(`/api/books/${encodeURIComponent('书A')}/trash`)
    expect(r).toEqual([{ id: 't1', path: 'a.md' }])

    stubFetch(() => ok({}))
    expect(await listTrash('书A')).toEqual([])
  })

  it('restoreTrash / purgeTrash：POST restore 与 DELETE 口径', async () => {
    stubFetch(() => ok({ ok: true }))
    await restoreTrash('书A', 't1')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.url).toBe(`/api/books/${encodeURIComponent('书A')}/trash/t1/restore`)

    await purgeTrash('书A', 't1')
    expect(calls[1]!.init?.method).toBe('DELETE')
    expect(calls[1]!.url).toBe(`/api/books/${encodeURIComponent('书A')}/trash/t1`)
  })
})
