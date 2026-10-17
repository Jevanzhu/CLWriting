import { apiJson, ApiError } from './client'
import { bookUrl } from './url'

// 三审结果类型单源 = src/shared/contract/review.ts（服务端同源注解）。
import type { CollectedReview, ReviewEnvelope, ReviewIssue, ReviewResult } from '../../../../shared/contract/review'
export type ReviewIssueFE = ReviewIssue
export type CollectedReviewFE = CollectedReview
export type {
  ReviewEnvelope,
  ReviewResult,
  ReviewVerdict,
} from '../../../../shared/contract/review'
type EnvelopeGet = { ok: true; envelope: ReviewEnvelope; stale: boolean }

// POST /documents/:docId/review —— 三审直读（M12 B0.2，需 AI 可达）。
export async function runReview(name: string, docId: string): Promise<ReviewResult> {
  return apiJson<ReviewResult>(
    bookUrl(name, 'documents', docId, 'review'),
    { method: 'POST', json: {} },
    600_000, // 三审超时 10 分钟——真实 provider 串行 3 视角单次 1-3 分钟常态，120s 必假超时（服务端继续跑完落信封，费用照花）
  )
}

// POST /documents/:docId/review-verdict —— 作者裁决（落 review 信封 payload.verdict，M12 B1.3 方案 A）
export async function runVerdictDoc(name: string, docId: string, approved: boolean): Promise<void> {
  await apiJson<{ ok: true }>(bookUrl(name, 'documents', docId, 'review-verdict'), {
    method: 'POST',
    json: { approved },
  })
}

// GET /documents/:docId/analysis/review —— 读存量三审信封（无则 null；stale=正文已变更）。
export async function getReviewEnvelope(
  name: string,
  docId: string,
): Promise<{ envelope: ReviewEnvelope; stale: boolean } | null> {
  try {
    const r = await apiJson<EnvelopeGet>(bookUrl(name, 'documents', docId, 'analysis', 'review'))
    return { envelope: r.envelope, stale: r.stale }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null // 确无存量信封
    throw e // 服务端故障/网络错误上抛（调用方 toast）
  }
}
