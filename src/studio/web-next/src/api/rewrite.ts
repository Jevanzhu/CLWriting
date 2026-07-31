import { apiJson } from './client'

// 改写结果（镜像后端 DiffLine + { mode, original, rewritten, diff }）。
export interface DiffLineFE {
  type: 'same' | 'add' | 'del'
  text: string
}
export interface RewriteResult {
  ok: true
  mode: 'local' | 'whole' | 'append'
  original: string
  rewritten: string
  diff: DiffLineFE[]
}

// POST /documents/:docId/rewrite —— 改写直读（M12 B2.1，需 AI）。
// selection 非空 → local 选段改写；空 → whole 整章改写；append → 续写（只产新增部分，M2）。
export async function runRewriteDoc(
  name: string,
  docId: string,
  body: { instruction: string; selection?: string; append?: boolean },
): Promise<RewriteResult> {
  return apiJson<RewriteResult>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/rewrite`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
}
