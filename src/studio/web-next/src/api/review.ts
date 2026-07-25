import { apiJson } from './client'

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
export interface ReviewEnvelope {
  generatedAt: string
  model: string
  sourceHash: string
  payload: { collected: CollectedReviewFE; lenses: string[] }
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
  } catch {
    return null
  }
}
