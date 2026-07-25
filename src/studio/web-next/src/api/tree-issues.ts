import { apiJson } from './client'

// GET /tree-issues（T9b 树红点冒泡）：聚合定稿正文「机检 red + verdict 驳回」，
// 返 { docId: { hasRed, verdictRejected } }（仅含有 issue 的 docId，余省略）。
// rebuild 失败时后端降级返空 issues + warning（不阻塞树渲染）。
export interface TreeIssue {
  hasRed: boolean
  verdictRejected: boolean
}
interface TreeIssuesResp {
  ok: true
  issues: Record<string, TreeIssue>
  warning?: string
}

export async function getTreeIssues(name: string): Promise<TreeIssuesResp> {
  return apiJson<TreeIssuesResp>(`/api/books/${encodeURIComponent(name)}/tree-issues`)
}
