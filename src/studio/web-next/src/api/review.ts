import { apiJson, ApiError } from './client'

// 三审结果类型（镜像后端 src/review/run.ts CollectedReview + normalized 精简）。
export interface ReviewIssueFE {
  lens: string
  severity: string
  category: string
  location: string
  evidence: string[]
  issue: string
  fix: string
  blocking?: boolean
}
export interface CollectedReviewFE {
  ok: boolean
  collected_lenses: string[]
  missing_lenses: string[]
  /** R63-4（十一轮）：采集失败明细（stale/坏条目）——passed 判定须查 ok/bad_entries，
   *  修复前旧信封无此字段（optional 兼容），后端同名字段随 collected 原样透传 */
  bad_entries?: { path: string; reason: string }[]
  raw_issues: ReviewIssueFE[]
  normalized: {
    blockers: ReviewIssueFE[]
    warnings: ReviewIssueFE[]
    invalid_issues: ReviewIssueFE[]
    passed: boolean
  }
  tier: string
  chapter: number
  lenses_run: string[]
}
export interface ReviewResult {
  ok: true
  lenses: string[]
  collected: CollectedReviewFE
}
export interface ReviewVerdict {
  approved: boolean
  at: string
}
export interface ReviewEnvelope {
  generatedAt: string
  model: string
  sourceHash: string
  /** R63-4（十一轮）：采集失败（ok:false）信封打 incomplete 标记——旧信封无此字段 */
  payload: { collected: CollectedReviewFE; lenses: string[]; verdict?: ReviewVerdict; incomplete?: true }
}
interface EnvelopeGet {
  ok: true
  envelope: ReviewEnvelope
  stale: boolean
}

// POST /documents/:docId/review —— 三审直读（M12 B0.2，需 AI 可达）。
export async function runReview(name: string, docId: string): Promise<ReviewResult> {
  return apiJson<ReviewResult>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/review`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    600_000, // X-P1-4：三审超时 10 分钟——真实 provider 串行 3 视角单次 1-3 分钟常态，120s 必假超时（服务端继续跑完落信封，费用照花）
  )
}

// POST /documents/:docId/review-verdict —— 作者裁决（落 review 信封 payload.verdict，M12 B1.3 方案 A）
export async function runVerdictDoc(name: string, docId: string, approved: boolean): Promise<void> {
  await apiJson<{ ok: true }>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/review-verdict`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved }) },
  )
}

// GET /documents/:docId/analysis/review —— 读存量三审信封（无则 null；stale=正文已变更）。
export async function getReviewEnvelope(
  name: string,
  docId: string,
): Promise<{ envelope: ReviewEnvelope; stale: boolean } | null> {
  try {
    const r = await apiJson<EnvelopeGet>(
      `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/analysis/review`,
    )
    return { envelope: r.envelope, stale: r.stale }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null // 确无存量信封
    throw e // 服务端故障/网络错误上抛（调用方 toast）
  }
}
