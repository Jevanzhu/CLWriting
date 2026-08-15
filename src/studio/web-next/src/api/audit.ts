// F1-P5 审计客户端：GET /api/books/:name/audit → 事件重放 + 遮蔽差异 + 工作流链路。
import { apiJson } from './client'

/** 审计事件（带投影遮蔽标记 + 血缘引用） */
export interface AuditEventFE {
  seq: number
  sessionId: string
  type: string
  surfaceOp?: string
  shadowed: boolean
  sourceSeqs?: number[]
  data: Record<string, unknown>
}

/** 投影节点（审计差异视图） */
export interface AuditNodeFE {
  seq: number
  kind: 'user-text' | 'assistant' | 'tool-result'
  role: 'user' | 'assistant'
  shadowed: boolean
  preview: string
}

export interface AuditConversationFE {
  events: AuditEventFE[]
  modelVisible: AuditNodeFE[]
  humanVisible: AuditNodeFE[]
  shadowedCount: number
}

export interface AuditViewFE {
  conversation: AuditConversationFE | null
  workflowEvents: AuditEventFE[]
}

/** GET /api/books/:name/audit → 审计视图 */
export async function getAudit(bookName: string): Promise<AuditViewFE> {
  return apiJson<AuditViewFE>('/api/books/' + encodeURIComponent(bookName) + '/audit')
}
