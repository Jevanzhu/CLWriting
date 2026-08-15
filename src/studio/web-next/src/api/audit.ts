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

/** F5：goal 当前态快照（foldGoals 重放） */
export interface GoalFE {
  id: string
  title: string
  description?: string
  state: 'active' | 'paused' | 'blocked' | 'complete'
  roundsStarted: number
  maxGoalRounds?: number
  blockedReason?: string
  createdAt: number
  updatedAt: number
}

/** F5：todo 条目（foldTodos 重放，整表快照） */
export interface TodoFE {
  text: string
  state: 'pending' | 'in_progress' | 'completed'
}

export interface AuditViewFE {
  conversation: AuditConversationFE | null
  workflowEvents: AuditEventFE[]
  goals: GoalFE[]
  todos: TodoFE[]
}

/** GET /api/books/:name/audit → 审计视图 */
export async function getAudit(bookName: string): Promise<AuditViewFE> {
  return apiJson<AuditViewFE>('/api/books/' + encodeURIComponent(bookName) + '/audit')
}
