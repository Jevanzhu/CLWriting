import { apiJson } from './client'
import { bookUrl } from './url'

// 信封（镜像后端 Envelope；payload 按 kind 异构，前端按 kind 断言）。
interface EnvelopeFE {
  generatedAt: string
  model: string
  sourceHash: string
  payload: unknown
}

/** AI 章节标签（钩子/情绪/场景判定；后端校验后只含合法选项）。 */
interface ChapterTags {
  钩子类型?: string
  钩子强弱?: string
  情绪定位?: string
  场景?: string
  [k: string]: string | undefined
}
// POST /documents/:docId/autotag —— AI 读正文判定章节标签，返回 tags（不落信封；前端写 fm）。
export async function autotag(name: string, docId: string): Promise<ChapterTags> {
  const r = await apiJson<{ ok: true; tags: ChapterTags }>(
    bookUrl(name, 'documents', docId, 'autotag'),
    { method: 'POST', json: {} },
    60_000, // 标签判定超时 1 分钟
  )
  return r.tags
}

/** AI 推断的目标情绪/核心反转（从正文反推；不落信封；前端写 fm）。 */
interface InferredMeta {
  目标情绪?: string
  核心反转?: string
  [k: string]: string | undefined
}
// POST /documents/:docId/infer-meta —— AI 读正文反推目标情绪与核心反转（不落信封；前端写 fm）。
export async function inferMeta(name: string, docId: string): Promise<InferredMeta> {
  const r = await apiJson<{ ok: true; meta: InferredMeta }>(
    bookUrl(name, 'documents', docId, 'infer-meta'),
    { method: 'POST', json: {} },
    60_000,
  )
  return r.meta
}

// ── 全书聚合趋势（后端遍历 分析/<docId>.json 本地拼接，无 AI 依赖）──

/** 单章分析（POST /analyze）支持的 kind——后端白名单 = 此四值（review 走独立三审端点）。
 *  前端收窄成联合类型：kind 写错在编译期报错，不靠后端 400 BAD_KIND 兜。 */
export type AnalyzeKind = 'score' | 'emotion' | 'hooks' | 'style'

// POST /documents/:docId/analyze —— AI 读正文单章分析 → 信封落盘（增量：后端按 kind 覆盖该章信封）。
// 有成本 + 有任务闸（同书并发另一分析 → 409 BUSY；供应商未配置 → 400 NO_*/500 GEN_FAIL，
// 信封落盘与展示解耦——失败不清存量）。
export async function analyzeChapter(
  name: string,
  docId: string,
  kind: AnalyzeKind,
): Promise<{ envelope: EnvelopeFE }> {
  const r = await apiJson<{ ok: true; envelope: EnvelopeFE }>(
    bookUrl(name, 'documents', docId, 'analyze'),
    { method: 'POST', json: { kind } },
    120_000, // 单章分析超时 2 分钟（同文风分析档：AI 单次生成 1-3 分钟常态）
  )
  return { envelope: r.envelope }
}

interface ScoreTrendPoint {
  章号: number
  标题: string
  score: number
  dims: Record<string, number>
}
interface EmotionTrendPoint {
  章号: number
  标题: string
  emotion: number
  label: string
}
interface HooksTrendPoint {
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
  return apiJson<AnalysisOverview & { ok: true }>(bookUrl(name, 'analysis-overview'))
}

// POST /analyze-style —— 全书文风分析（全文 stats + 最近 10 章采样 → AI）。
// 完成时后端把口癖/建议转为候选（源3），styleCandidates 为新落候选数。
export async function runStyleAnalysis(name: string): Promise<{ envelope: EnvelopeFE; styleCandidates: number }> {
  const r = await apiJson<{ ok: true; envelope: EnvelopeFE; styleCandidates?: number }>(
    bookUrl(name, 'analyze-style'),
    { method: 'POST', json: {} },
    120_000, // AI 文风分析超时 2 分钟
  )
  return { envelope: r.envelope, styleCandidates: r.styleCandidates ?? 0 }
}
