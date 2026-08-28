/**
 * G-2（二十轮）：api 桶补测——AI/文风/服务商域端点行为级直测（走真实 client + 桩 fetch）。
 * 覆盖 style/analysis/review/rewrite/providers 的 URL 编码、method、body 负载、响应解包
 * 与 404→null 兜底（信封读取三态）。书级状态端点见 api-endpoints-a.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  listStyleEntries,
  addStyleEntry,
  deleteStyleEntry,
  listStyleCandidates,
  confirmStyleCandidate,
  ignoreStyleCandidate,
  runStyleHarvest,
  getStyleConfig,
  freezeStyleBaseline,
  getStyleTrend,
} from '../../../src/studio/web-next/src/api/style'
import {
  getAnalysisEnvelope,
  runAnalyze,
  autotag,
  inferMeta,
  getAnalysisOverview,
  runStyleAnalysis,
} from '../../../src/studio/web-next/src/api/analysis'
import { runReview, runVerdictDoc, getReviewEnvelope } from '../../../src/studio/web-next/src/api/review'
import { runRewriteDoc, reportAiVersion } from '../../../src/studio/web-next/src/api/rewrite'
import {
  getProviders,
  fetchModels,
  createProvider,
  updateProvider,
  deleteProvider,
  setCurrentProvider,
  testProvider,
  setTiers,
  setChatTier,
  getRagProviders,
  createRagProvider,
  updateRagProvider,
} from '../../../src/studio/web-next/src/api/providers'
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
  stubFetch(() => new Response(JSON.stringify({ token: 'T-epb' }), { status: 200 }))
  await boot()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function lastCall(): Call {
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]!
}
function jsonBody(c: Call): Record<string, unknown> {
  return JSON.parse(String(c.init?.body ?? '{}')) as Record<string, unknown>
}

const ENVELOPE = { generatedAt: 't', model: 'm', sourceHash: 'h', payload: {} }

describe('api style · 文风条目/候选/基线', () => {
  it('listStyleEntries / listStyleCandidates / getStyleConfig / getStyleTrend：GET 与编码', async () => {
    stubFetch(() => ok({}))
    await listStyleEntries('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/style/entries')
    await listStyleCandidates('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/style/candidates')
    await getStyleConfig('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/style/config')
    await getStyleTrend('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/health/style')
  })

  it('addStyleEntry：POST 条目负载；deleteStyleEntry：DELETE {path}', async () => {
    stubFetch(() => ok({ path: 'x.md' }))
    await addStyleEntry('书 A', { 类型: '样章', 正文: '文' })
    expect(lastCall().init?.method).toBe('POST')
    expect(jsonBody(lastCall())).toEqual({ 类型: '样章', 正文: '文' })
    await deleteStyleEntry('书 A', '条目 a.md')
    expect(lastCall().init?.method).toBe('DELETE')
    expect(jsonBody(lastCall())).toEqual({ path: '条目 a.md' })
  })

  it('confirm / ignore 候选：POST {path}；harvest/freeze：POST', async () => {
    stubFetch(() => ok({ entryPath: 'e.md' }))
    await confirmStyleCandidate('书 A', '候选 1.md')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/style/candidates/confirm')
    expect(jsonBody(lastCall())).toEqual({ path: '候选 1.md' })
    await ignoreStyleCandidate('书 A', '候选 1.md')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/style/candidates/ignore')
    await runStyleHarvest('书 A')
    expect(lastCall().init?.method).toBe('POST')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/style/harvest')
    await freezeStyleBaseline('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/style/baseline/freeze')
  })
})

describe('api analysis · 信封三态 + AI 端点', () => {
  it('getAnalysisEnvelope：命中解包 {envelope, stale}', async () => {
    stubFetch(() => ok({ ok: true, envelope: ENVELOPE, stale: true }))
    const r = await getAnalysisEnvelope('书 A', 'doc 1', 'score')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/documents/doc%201/analysis/score')
    expect(r?.stale).toBe(true)
    expect(r?.envelope.model).toBe('m')
  })

  it('getAnalysisEnvelope：404 → null（确无信封）；500 → 上抛', async () => {
    stubFetch(() => ok({ error: '无' }, 404))
    expect(await getAnalysisEnvelope('书 A', 'd', 'score')).toBeNull()
    stubFetch(() => ok({ error: '炸' }, 500))
    await expect(getAnalysisEnvelope('书 A', 'd', 'score')).rejects.toBeInstanceOf(ApiError)
  })

  it('runAnalyze：POST {kind} 解包 envelope；autotag/inferMeta：POST {} 解包字段', async () => {
    stubFetch(() => ok({ ok: true, envelope: ENVELOPE }))
    const env = await runAnalyze('书 A', 'd1', 'emotion')
    expect(lastCall().init?.method).toBe('POST')
    expect(jsonBody(lastCall())).toEqual({ kind: 'emotion' })
    expect(env.sourceHash).toBe('h')
    stubFetch(() => ok({ ok: true, tags: { 钩子类型: '悬念钩' } }))
    expect((await autotag('书 A', 'd1')).钩子类型).toBe('悬念钩')
    stubFetch(() => ok({ ok: true, meta: { 目标情绪: '压抑' } }))
    expect((await inferMeta('书 A', 'd1')).目标情绪).toBe('压抑')
  })

  it('getAnalysisOverview：GET；runStyleAnalysis：POST 且 styleCandidates 缺省 0', async () => {
    stubFetch(() => ok({ ok: true, scoreTrend: [], emotionTrend: [], hooksTrend: [], style: null, allChapters: [] }))
    await getAnalysisOverview('书 A')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/analysis-overview')
    stubFetch(() => ok({ ok: true, envelope: ENVELOPE }))
    const r = await runStyleAnalysis('书 A')
    expect(lastCall().init?.method).toBe('POST')
    expect(r.styleCandidates).toBe(0)
    stubFetch(() => ok({ ok: true, envelope: ENVELOPE, styleCandidates: 3 }))
    expect((await runStyleAnalysis('书 A')).styleCandidates).toBe(3)
  })
})

describe('api review/rewrite · 三审与改写', () => {
  it('runReview：POST /review；runVerdictDoc：POST {approved}', async () => {
    stubFetch(() => ok({ ok: true, lenses: [], collected: {} }))
    await runReview('书 A', 'd1')
    expect(lastCall().init?.method).toBe('POST')
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/documents/d1/review')
    await runVerdictDoc('书 A', 'd1', true)
    expect(lastCall().url).toBe('/api/books/%E4%B9%A6%20A/documents/d1/review-verdict')
    expect(jsonBody(lastCall())).toEqual({ approved: true })
  })

  it('getReviewEnvelope：404 → null 兜底（R72 面同 analysis）', async () => {
    stubFetch(() => ok({ error: '无' }, 404))
    expect(await getReviewEnvelope('书 A', 'd1')).toBeNull()
  })

  it('runRewriteDoc：POST {instruction, selection}；reportAiVersion：POST {content}', async () => {
    stubFetch(() => ok({ ok: true, mode: 'local', original: 'a', rewritten: 'b', diff: [] }))
    await runRewriteDoc('书 A', 'd1', { instruction: '收紧', selection: '段' })
    expect(lastCall().init?.method).toBe('POST')
    expect(jsonBody(lastCall())).toEqual({ instruction: '收紧', selection: '段' })
    await reportAiVersion('书 A', 'd1', '全文')
    expect(jsonBody(lastCall())).toEqual({ content: '全文' })
  })
})

describe('api providers · 服务商与档位', () => {
  it('getProviders / getRagProviders：GET 应用级路径', async () => {
    stubFetch(() => ok({ providers: [], currentId: null, currentModel: null, tiers: {}, revision: 1 }))
    await getProviders()
    expect(lastCall().url).toBe('/api/providers')
    await getRagProviders()
    expect(lastCall().url).toBe('/api/rag-providers')
  })

  it('fetchModels：POST 透传两种负载形态', async () => {
    stubFetch(() => ok({ models: ['m1'] }))
    await fetchModels({ id: 'p1' })
    expect(jsonBody(lastCall())).toEqual({ id: 'p1' })
    await fetchModels({ protocol: 'openai', baseUrl: 'http://x', apiKey: 'k' })
    expect(jsonBody(lastCall())).toEqual({ protocol: 'openai', baseUrl: 'http://x', apiKey: 'k' })
  })

  it('createProvider POST / updateProvider PUT :id（编码）', async () => {
    stubFetch(() => ok({ provider: {}, revision: 2 }))
    await createProvider({ name: 'n', protocol: 'openai', baseUrl: 'u', apiKey: 'k' })
    expect(lastCall().init?.method).toBe('POST')
    await updateProvider('p 1', { name: 'n2', protocol: 'openai', baseUrl: 'u', apiKey: '' })
    expect(lastCall().init?.method).toBe('PUT')
    expect(lastCall().url).toBe('/api/providers/p%201')
  })

  it('deleteProvider：有 expectedRevision 才带 JSON body；无则裸 DELETE', async () => {
    stubFetch(() => ok({ ok: true, currentId: null, revision: 3 }))
    await deleteProvider('p1')
    expect(lastCall().init?.method).toBe('DELETE')
    expect(lastCall().init?.body).toBeUndefined()
    await deleteProvider('p1', 3)
    expect(jsonBody(lastCall())).toEqual({ expectedRevision: 3 })
  })

  it('setCurrentProvider：PUT {id, expectedRevision}', async () => {
    stubFetch(() => ok({ ok: true, currentId: 'p1' }))
    await setCurrentProvider('p1', 4)
    expect(lastCall().init?.method).toBe('PUT')
    expect(jsonBody(lastCall())).toEqual({ id: 'p1', expectedRevision: 4 })
  })

  it('testProvider：model 有无两态负载（60s 档）', async () => {
    stubFetch(() => ok({ ok: true }))
    await testProvider('p1')
    expect(jsonBody(lastCall())).toEqual({})
    await testProvider('p1', 'm-1')
    expect(jsonBody(lastCall())).toEqual({ model: 'm-1' })
  })

  it('setTiers PUT /api/tiers；setChatTier 三态负载', async () => {
    stubFetch(() => ok({ ok: true, tiers: {}, revision: 5 }))
    await setTiers({ creative: { model: 'm', effort: 'high' }, assistant: null, expectedRevision: 5 })
    expect(lastCall().init?.method).toBe('PUT')
    expect(lastCall().url).toBe('/api/tiers')
    await setChatTier({ model: 'm', effort: 'low' }, 5)
    expect(jsonBody(lastCall())).toEqual({ model: 'm', effort: 'low', expectedRevision: 5 })
    await setChatTier(null, 5)
    expect(jsonBody(lastCall())).toEqual({ clear: true, expectedRevision: 5 })
    await setChatTier(null)
    expect(lastCall().init?.body).toBe('null') // 无 expectedRevision 的清除态：负载字面 null
  })

  it('RAG 服务商：create POST / update PUT :id', async () => {
    stubFetch(() => ok({ provider: {}, revision: 1 }))
    await createRagProvider({ name: 'n', endpoint: 'e', model: 'm', apiKey: 'k' })
    expect(lastCall().init?.method).toBe('POST')
    expect(lastCall().url).toBe('/api/rag-providers')
    await updateRagProvider('r 1', { name: 'n', endpoint: 'e', model: 'm', apiKey: '' })
    expect(lastCall().init?.method).toBe('PUT')
    expect(lastCall().url).toBe('/api/rag-providers/r%201')
  })
})
