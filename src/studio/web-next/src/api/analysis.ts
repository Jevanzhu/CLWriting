import { apiJson } from './client'

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
  } catch {
    return null
  }
}

// POST /documents/:docId/analyze —— 重新分析（需 AI 可达）。
export async function runAnalyze(name: string, docId: string, kind: AnalysisKindFE): Promise<EnvelopeFE> {
  const r = await apiJson<AnalyzePost>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/analyze`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) },
  )
  return r.envelope
}
