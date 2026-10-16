import { apiJson } from './client'
import { bookUrl } from './url'

// GET /tree-issues（T9b 树红点冒泡）：聚合定稿正文「机检 red + verdict 驳回」，
// 返 { docId: { hasRed, verdictRejected } }（仅含有 issue 的 docId，余省略）。
// 四类降级（机检索引构建失败 / 账本全书性项失败 / 单章机检失败 / 清单读失败）时
// issues 不全 + warnings 逐条说明，不阻塞树渲染。消费方 = stores/tree.ts issueWarnings
// → ChapterTreePanel 降级提示行。
export interface TreeIssue {
  hasRed: boolean
  verdictRejected: boolean
}
interface TreeIssuesResp {
  ok: true
  issues: Record<string, TreeIssue>
  warnings?: string[]
}

export async function getTreeIssues(name: string): Promise<TreeIssuesResp> {
  return apiJson<TreeIssuesResp>(bookUrl(name, 'tree-issues'))
}
