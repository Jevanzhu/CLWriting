/**
 * G-2（二十轮）：api 桶补测——书级状态/内容端点行为级直测（走真实 client + 桩 fetch，
 * 先例 api-documents.test.ts）。覆盖此前 0%/低覆盖的薄封装：URL 编码、method、query
 * 拼装、body 负载、响应解包映射。AI/服务商/文风域见 api-endpoints-b.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getAudit, clearAudit } from '../../../src/studio/web-next/src/api/audit'
import { getOverview } from '../../../src/studio/web-next/src/api/overview'
import { getRhythm } from '../../../src/studio/web-next/src/api/rhythm'
import { getSettings, mineRelations, getCompletionNames } from '../../../src/studio/web-next/src/api/settings'
import { getStartupNotices } from '../../../src/studio/web-next/src/api/startup-notices'
import { getTraceStats } from '../../../src/studio/web-next/src/api/trace-stats'
import { getAiStatus } from '../../../src/studio/web-next/src/api/ai-status'
import { getCostStats } from '../../../src/studio/web-next/src/api/cost-stats'
import { getForeshadows } from '../../../src/studio/web-next/src/api/foreshadows'
import { search } from '../../../src/studio/web-next/src/api/search'
import {
  getTree,
  getConfig,
  putConfig,
  getWordsDiary,
  postBaseline,
  renameBook,
  getRagStatus,
  triggerRagBuild,
} from '../../../src/studio/web-next/src/api/books'
import * as shelf from '../../../src/studio/web-next/src/api/shelf'
import {
  listSnapshots,
  readSnapshot,
  restoreSnapshot,
  getVersionStats,
  pruneVersions,
} from '../../../src/studio/web-next/src/api/snapshots'
import { runCheck, markFalsePositive } from '../../../src/studio/web-next/src/api/check'
import { runLearn, runLearnCommit } from '../../../src/studio/web-next/src/api/learn'
import { boot } from '../../../src/studio/web-next/src/api/client'

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
  stubFetch(() => new Response(JSON.stringify({ token: 'T-ep' }), { status: 200 }))
  await boot()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}
function lastCall(): Call {
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]!
}
function jsonBody(c: Call): Record<string, unknown> {
  return JSON.parse(String(c.init?.body ?? '{}')) as Record<string, unknown>
}

describe('api 状态端点 · URL 编码 + method', () => {
  it('getAudit：书名编码；无分页无 query；分页参数拼 query', async () => {
    stubFetch(() => ok({ conversation: null, workflowEvents: [], workflowTotal: 0, goals: [], todos: [] }))
    await getAudit('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/audit')
    await getAudit('书 A', { limit: 50, offset: 100 })
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/audit?limit=50&offset=100')
  })

  it('clearAudit：DELETE 且书名编码', async () => {
    stubFetch(() => ok({ ok: true }))
    await clearAudit('书 A')
    expect(lastCall().init?.method).toBe('DELETE')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/audit')
  })

  it('getOverview / getRhythm / getSettings / getCompletionNames：GET 各自路径', async () => {
    stubFetch(() => ok({}))
    await getOverview('书&名')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%26%E5%90%8D/overview')
    await getRhythm('书&名')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%26%E5%90%8D/rhythm')
    await getSettings('书&名')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%26%E5%90%8D/settings')
    await getCompletionNames('书&名')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%26%E5%90%8D/completion-names')
  })

  it('mineRelations：POST force 负载（AI 梳理）', async () => {
    stubFetch(() => ok({ ok: true, cached: false, relations: [] }))
    await mineRelations('书 A', true)
    expect(lastCall().init?.method).toBe('POST')
    expect(jsonBody(lastCall())).toEqual({ force: true })
  })

  it('getStartupNotices：notices 缺失 → 空数组兜底', async () => {
    stubFetch(() => ok({}))
    expect(await getStartupNotices()).toEqual([])
    stubFetch(() => ok({ notices: [{ ts: '1', kind: 'm', message: 'x' }] }))
    expect(await getStartupNotices()).toEqual([{ ts: '1', kind: 'm', message: 'x' }])
  })

  it('getTraceStats / getAiStatus / getCostStats / getForeshadows：GET 与书名编码', async () => {
    stubFetch(() => ok({}))
    await getTraceStats('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/trace-stats')
    await getAiStatus()
    expect(lastCall().url).toBe('/api/ai-status')
    await getCostStats('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/cost-stats')
    await getForeshadows('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/foreshadows')
  })

  it('search：q 与 scope 均编码', async () => {
    stubFetch(() => ok({ results: [] }))
    await search('书 A', '龙 兴&起', '定稿')
    expect(lastCall().url).toBe(
      '/api/books/%E4%B9%A6%20A/search?q=%E9%BE%99%20%E5%85%B4%26%E8%B5%B7&scope=%E5%AE%9A%E7%A8%BF',
    )
  })
})

describe('api 书级操作 · books/shelf', () => {
  it('listBooks：GET /api/books（shelf 模块，books[]/workDir 解构）', async () => {
    stubFetch(() => ok({ books: [{ name: '书 A' }], workDir: true }))
    const r = await shelf.listBooks()
    expect(lastCall().url).toBe('/api/books')
    expect(r.books).toHaveLength(1)
    expect(r.workDir).toBe(true)
  })

  it('deleteBook：DELETE 且书名编码', async () => {
    stubFetch(() => ok({ ok: true }))
    await shelf.deleteBook('书 A')
    expect(lastCall().init?.method).toBe('DELETE')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A')
  })

  it('getTree：refresh=true 拼 ?refresh=1', async () => {
    stubFetch(() => ok({ nodes: [], revision: 'r1' }))
    await getTree('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/tree')
    await getTree('书 A', true)
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/tree?refresh=1')
  })

  it('getConfig 解包 .config；putConfig PUT 全量 {config}', async () => {
    stubFetch(() => ok({ config: { kind: 'long', book: { title: 'T' } } }))
    const cfg = await getConfig('书 A')
    expect(cfg.book?.title).toBe('T')
    await putConfig('书 A', { kind: 'long', book: { title: '新' } })
    expect(lastCall().init?.method).toBe('PUT')
    expect(jsonBody(lastCall())).toEqual({ config: { kind: 'long', book: { title: '新' } } })
  })

  it('words-diary：GET / POST baseline', async () => {
    stubFetch(() => ok({ date: '2026-08-28', baseline: 100, delta: 5 }))
    await getWordsDiary('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/words-diary')
    await postBaseline('书 A', 100)
    expect(lastCall().init?.method).toBe('POST')
    expect(jsonBody(lastCall())).toEqual({ baseline: 100 })
  })

  it('renameBook：POST {name}；结果透传（renamed/eventsMigrationFailed）', async () => {
    stubFetch(() => ok({ ok: true, renamed: true, name: '新书', path: '/x', eventsMigrationFailed: true }))
    const r = await renameBook('旧书', '新书')
    expect(lastCall().init?.method).toBe('POST')
    expect(jsonBody(lastCall())).toEqual({ name: '新书' })
    expect(r.renamed).toBe(true)
    expect(r.eventsMigrationFailed).toBe(true)
  })

  it('RAG：GET status / POST build', async () => {
    stubFetch(() => ok({}))
    await getRagStatus('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/rag/status')
    await triggerRagBuild('书 A')
    expect(lastCall().init?.method).toBe('POST')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/rag/build')
  })
})

describe('api 版本与机检 · snapshots/check', () => {
  it('listSnapshots 解包 entries；readSnapshot 编码 id 解包 content', async () => {
    stubFetch(() => ok({ entries: [{ id: 'v1', time: 1, origin: 'o', reason: 'r', words: 3, pinned: false }] }))
    const list = await listSnapshots('书 A', 'doc 1')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/documents/doc%201/snapshots')
    expect(list).toHaveLength(1)
    stubFetch(() => ok({ content: '正文' }))
    expect(await readSnapshot('书 A', 'doc 1', 'v 1')).toBe('正文')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/documents/doc%201/snapshots/v%201')
  })

  it('restoreSnapshot：POST expectedRevision 负载', async () => {
    stubFetch(() => ok({ revision: 'r2', content: '旧文' }))
    const r = await restoreSnapshot('书 A', 'doc1', 'v1', 'sha256:x')
    expect(lastCall().init?.method).toBe('POST')
    expect(jsonBody(lastCall())).toEqual({ expectedRevision: 'sha256:x' })
    expect(r.revision).toBe('r2')
  })

  it('getVersionStats 映射四字段；pruneVersions 解包 removed', async () => {
    stubFetch(() => ok({ ok: true, snapshotBytes: 10, snapshotCount: 2, pinnedCount: 1, finalizedDocs: 3 }))
    const s = await getVersionStats('书 A')
    expect(s).toEqual({ snapshotBytes: 10, snapshotCount: 2, pinnedCount: 1, finalizedDocs: 3 })
    stubFetch(() => ok({ removed: 7 }))
    expect(await pruneVersions('书 A')).toBe(7)
    expect(lastCall().init?.method).toBe('POST')
  })

  it('runCheck：POST 空对象负载；markFalsePositive：POST {checkId}', async () => {
    stubFetch(() => ok({ ok: true, report: { sections: [] }, hasRed: false }))
    await runCheck('书 A', 'doc1')
    expect(lastCall().init?.method).toBe('POST')
    expect(jsonBody(lastCall())).toEqual({})
    await markFalsePositive('书 A', 'doc1', 'repeat')
    expect(jsonBody(lastCall())).toEqual({ checkId: 'repeat' })
  })
})

describe('api learn · R72-3 后的端点契约', () => {
  it('runLearn：POST /learn；runLearnCommit：POST {samples,quotes} 负载', async () => {
    stubFetch(() => ok({ samples: [], quotes: [] }))
    await runLearn('书 A')
    expect(lastCall().init?.method).toBe('POST')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/learn')
    await runLearnCommit('书 A', { samples: [{ 场景: '通用', 正文: 'x', 出处: 'y', 章号: 1, 打分: 80 }], quotes: [] })
    expect(lastCall().init?.method).toBe('POST')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/learn-commit')
    const body = jsonBody(lastCall())
    expect((body['samples'] as unknown[]).length).toBe(1)
    expect(body['quotes']).toEqual([])
  })
})
