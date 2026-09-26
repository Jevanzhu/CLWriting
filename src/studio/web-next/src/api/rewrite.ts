import { apiJson } from './client'
import { bookUrl } from './url'

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

// POST /documents/:docId/rewrite —— 改写直读（M12 .1，需 AI）。
// selection 非空 → local 选段改写；空 → whole 整章改写；append → 续写（只产新增部分）。
export async function runRewriteDoc(
  name: string,
  docId: string,
  body: { instruction: string; selection?: string; append?: boolean },
): Promise<RewriteResult> {
  return apiJson<RewriteResult>(
    bookUrl(name, 'documents', docId, 'rewrite'),
    { method: 'POST', json: body },
    120_000, // AI 改写超时 2 分钟
  )
}

// POST /documents/:docId/ai-version —— 改稿轨迹采集（文风）：接受改写时上报 AI 版全文。
// fire-and-forget 语义：轨迹是旁路证据，失败由调用方静默吞掉，不阻断接受。
export async function reportAiVersion(name: string, docId: string, content: string): Promise<void> {
  await apiJson(
    bookUrl(name, 'documents', docId, 'ai-version'),
    { method: 'POST', json: { content } },
  )
}
