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
  /** AA-P2-1：对话事件总条数（与 events.length 区分——前者是当前页条数，后者是能否翻页的总数） */
  eventsTotal: number
  modelVisible: AuditNodeFE[]
  humanVisible: AuditNodeFE[]
  shadowedCount: number
}

/** AA-P2-1：分页参数（limit 服务端夹取 1..500；offset 为已载条数起点） */
export interface AuditPagingFE {
  limit?: number
  offset?: number
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
  /** AA-P2-1：工作流事件总条数（分页续页用） */
  workflowTotal: number
  goals: GoalFE[]
  todos: TodoFE[]
}

/** GET /api/books/:name/audit → 审计视图（可选分页参数，AA-P2-1：前端翻页靠 offset 推进） */
export async function getAudit(bookName: string, paging?: AuditPagingFE): Promise<AuditViewFE> {
  const q = new URLSearchParams()
  if (paging?.limit !== undefined) q.set('limit', String(paging.limit))
  if (paging?.offset !== undefined) q.set('offset', String(paging.offset))
  const qs = q.toString()
  return apiJson<AuditViewFE>(
    '/api/books/' + encodeURIComponent(bookName) + '/audit' + (qs ? '?' + qs : ''),
  )
}

/** 事件保留定版：清除本书事件史（销毁动作——对话 + 工作流两侧；调前需作者二次确认）。
 *  R26-82（二十六轮，登记顺手改档）：销毁链删除大量事件可达秒级，30s 默认兜底档偏紧，
 *  显式配 120s 慢档（对齐 AI 分析/收割类慢端点档位）。 */
export async function clearAudit(bookName: string): Promise<void> {
  await apiJson<{ ok: true }>('/api/books/' + encodeURIComponent(bookName) + '/audit', { method: 'DELETE' }, 120_000)
}
