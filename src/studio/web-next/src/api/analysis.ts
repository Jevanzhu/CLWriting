import { apiJson, ApiError } from './client'

// 分析载荷种类（review 走独立三审端点，不在此）。
export type AnalysisKindFE = 'score' | 'emotion' | 'hooks' | 'style'

// 信封（镜像后端 Envelope；payload 按 kind 异构，前端按 kind 断言）。
export interface EnvelopeFE {
  generatedAt: string
  model: string
  sourceHash: string
  payload: unknown
}
interface EnvelopeGet {
  ok: true
  envelope: EnvelopeFE
  stale: boolean
}
interface AnalyzePost {
  ok: true
  envelope: EnvelopeFE
}

// GET /documents/:docId/analysis/:kind —— 读存量信封（无则 null；stale=正文已变更）。
export async function getAnalysisEnvelope(
  name: string,
  docId: string,
  kind: AnalysisKindFE,
): Promise<{ envelope: EnvelopeFE; stale: boolean } | null> {
  try {
    const r = await apiJson<EnvelopeGet>(
      `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/analysis/${kind}`,
    )
    return { envelope: r.envelope, stale: r.stale }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null // 确无存量信封
    throw e // 服务端故障/网络错误上抛（调用方 toast）
  }
}

// POST /documents/:docId/analyze —— 重新分析（需 AI 可达）。
export async function runAnalyze(name: string, docId: string, kind: AnalysisKindFE): Promise<EnvelopeFE> {
  const r = await apiJson<AnalyzePost>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/analyze`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) },
    120_000, // AI 分析超时 2 分钟
  )
  return r.envelope
}

/** AI 章节标签（钩子/情绪/场景判定；后端校验后只含合法选项）。 */
export interface ChapterTags {
  钩子类型?: string
  钩子强弱?: string
  情绪定位?: string
  场景?: string
  [k: string]: string | undefined
}
// POST /documents/:docId/autotag —— AI 读正文判定章节标签，返回 tags（不落信封；前端写 fm）。
export async function autotag(name: string, docId: string): Promise<ChapterTags> {
  const r = await apiJson<{ ok: true; tags: ChapterTags }>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/autotag`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
    60_000, // 标签判定超时 1 分钟
  )
  return r.tags
}

/** AI 推断的目标情绪/核心反转（从正文反推；不落信封；前端写 fm）。 */
export interface InferredMeta {
  目标情绪?: string
  核心反转?: string
  [k: string]: string | undefined
}
// POST /documents/:docId/infer-meta —— AI 读正文反推目标情绪与核心反转（不落信封；前端写 fm）。
export async function inferMeta(name: string, docId: string): Promise<InferredMeta> {
  const r = await apiJson<{ ok: true; meta: InferredMeta }>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/infer-meta`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
    60_000,
  )
  return r.meta
}

// ── 全书聚合趋势（T1 后端遍历 分析/<docId>.json 本地拼接，无 AI 依赖）──

export interface ScoreTrendPoint {
  章号: number
  标题: string
  score: number
  dims: Record<string, number>
}
export interface EmotionTrendPoint {
  章号: number
  标题: string
  emotion: number
  label: string
}
export interface HooksTrendPoint {
  章号: number
  标题: string
  density: string
  hookCount: number
}
export interface StylePayload {
  drift: string
  口癖: string[]
  重复度评价: string
  建议: string[]
}
export interface AnalysisOverview {
  scoreTrend: ScoreTrendPoint[]
  emotionTrend: EmotionTrendPoint[]
  hooksTrend: HooksTrendPoint[]
  style: StylePayload | null
  /** 所有正文章节章号→docId 映射（供逐章/批量分析） */
  allChapters: { 章号: number; docId: string }[]
}

// GET /analysis-overview —— 全书聚合趋势（体验分/情绪/钩子逐章 + 全书文风）。
export async function getAnalysisOverview(name: string): Promise<AnalysisOverview> {
  return apiJson<AnalysisOverview & { ok: true }>(
    `/api/books/${encodeURIComponent(name)}/analysis-overview`,
  )
}

// POST /analyze-style —— 全书文风分析（全文 stats + 最近 10 章采样 → AI）。
// 完成时后端把口癖/建议转为候选（源3），styleCandidates 为新落候选数。
export async function runStyleAnalysis(
  name: string,
): Promise<{ envelope: EnvelopeFE; styleCandidates: number }> {
  const r = await apiJson<{ ok: true; envelope: EnvelopeFE; styleCandidates?: number }>(
    `/api/books/${encodeURIComponent(name)}/analyze-style`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
    120_000, // AI 文风分析超时 2 分钟
  )
  return { envelope: r.envelope, styleCandidates: r.styleCandidates ?? 0 }
}
