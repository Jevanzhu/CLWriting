/**
 * F1-P5 审计只读端点：事件重放 + 遮蔽差异视图数据。
 *
 * GET /api/books/:name/audit → {
 *   conversation: { events, modelVisible, humanVisible, shadowedCount },
 *   workflowEvents: [...],
 *   goals: [...], todos: [...]
 * }
 *
 * - conversation：对话会话（book = bookName）surface 投影——events 全量（含遮蔽标记）、
 *   modelVisible = 模型可见（未遮蔽）、humanVisible = 人类可见（含被遮蔽节点）、
 *   shadowedCount = 被 replace 遮蔽的节点数（人类抄本不被压缩遮蔽抹掉）；
 * - workflowEvents：写作工作流（book = bookHash(bookRoot)）step/llm-call 链路事件；
 * - goals/todos：工作流会话 goal/todo 事件的重放当前态（foldGoals/foldTodos，F5——
 *   self-heal 的修复目标与章节任务清单）。
 *
 * 纯只读（重放纯函数），不产生副作用。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { openSessionStore, bookHash, type SessionStore } from '../../../events/store.js'
import { foldSurface } from '../../../events/projection.js'
import { foldGoals, foldTodos } from '../../../events/goal-state.js'
import type { EventType, GoalSnapshot, SurfaceOp, Todo } from '../../../events/types.js'

interface AuditCtx {
  workDir: string | null
  userDataPath: string | null
}

/** 审计事件（带投影遮蔽标记 + 血缘引用） */
export interface AuditEvent {
  seq: number
  sessionId: string
  type: EventType
  surfaceOp?: SurfaceOp
  /** 对话投影中是否被 replace 遮蔽（仅对话会话有意义） */
  shadowed: boolean
  sourceSeqs?: number[]
  data: Record<string, unknown>
}

/** 投影节点（surface 消息，审计差异视图用） */
export interface AuditNode {
  seq: number
  kind: 'user-text' | 'assistant' | 'tool-result'
  role: 'user' | 'assistant'
  shadowed: boolean
  /** 内容预览（截断，避免大 payload 撑爆 UI） */
  preview: string
}

const PREVIEW_MAX = 200

function toPreview(content: string | unknown[]): string {
  if (typeof content === 'string') {
    return content.length > PREVIEW_MAX ? content.slice(0, PREVIEW_MAX) + '…' : content
  }
  const parts = (content as { type: string; text?: string }[]).map((b) =>
    b.type === 'text' ? b.text ?? '' : '[' + b.type + ']',
  )
  const s = parts.join(' ').trim()
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '…' : s
}

/** 对话审计视图（投影 + 遮蔽差异） */
export interface AuditConversation {
  events: AuditEvent[]
  /** P3-13：本页截断后的条数（与 eventsTotal 区分，前端可据此判断还有下一页） */
  eventsTotal: number
  modelVisible: AuditNode[]
  humanVisible: AuditNode[]
  shadowedCount: number
}

/** 分页参数（缺省 limit=500，offset=0） */
export interface AuditPaging {
  limit: number
  offset: number
}

const DEFAULT_PAGE_LIMIT = 500

function pageSlice<T>(arr: T[], paging: AuditPaging): T[] {
  const { limit, offset } = paging
  return arr.slice(offset, offset + limit)
}

/** 审计视图（对话 + 工作流 + goal/todo 当前态），纯函数——route 薄接线 + 单测直喂 store */
export function buildAuditView(
  store: SessionStore,
  bookName: string,
  bookRoot: string,
  paging: AuditPaging = { limit: DEFAULT_PAGE_LIMIT, offset: 0 },
): { conversation: AuditConversation | null; workflowEvents: AuditEvent[]; workflowTotal: number; goals: GoalSnapshot[]; todos: Todo[] } {
  // 对话会话（book = bookName）：surface 投影 + 遮蔽差异
  const convoEvents = store.listEvents(bookName)
  let conversation: AuditConversation | null = null
  if (convoEvents.length > 0) {
    const nodes = foldSurface(convoEvents)
    // P3-13：events 全量载荷按页截断（长书几万事件不再一次全量进 HTTP 响应）；total 供分页
    conversation = {
      events: pageSlice(
        convoEvents.map((e) => ({
          seq: e.seq,
          sessionId: e.sessionId,
          type: e.type,
          ...(e.surfaceOp !== undefined ? { surfaceOp: e.surfaceOp } : {}),
          shadowed: nodes.some((n) => n.seq === e.seq && n.shadowed),
          ...(e.sourceSeqs ? { sourceSeqs: e.sourceSeqs } : {}),
          data: e.data,
        })),
        paging,
      ),
      eventsTotal: convoEvents.length,
      modelVisible: nodes
        .filter((n) => !n.shadowed)
        .map((n) => ({ seq: n.seq, kind: n.kind, role: n.role, shadowed: false, preview: toPreview(n.content) })),
      humanVisible: nodes.map((n) => ({ seq: n.seq, kind: n.kind, role: n.role, shadowed: n.shadowed, preview: toPreview(n.content) })),
      shadowedCount: nodes.filter((n) => n.shadowed).length,
    }
  }

  // 写作工作流（book = bookHash）：step/llm-call 链路事件
  const wsEvents = store.listEvents(bookHash(bookRoot))
  const workflowEvents: AuditEvent[] = pageSlice(
    wsEvents.map((e) => ({
      seq: e.seq,
      sessionId: e.sessionId,
      type: e.type,
      ...(e.surfaceOp !== undefined ? { surfaceOp: e.surfaceOp } : {}),
      shadowed: false,
      ...(e.sourceSeqs ? { sourceSeqs: e.sourceSeqs } : {}),
      data: e.data,
    })),
    paging,
  )

  // F5：goal/todo 当前态（goal/todo 事件随 self-heal 落工作流会话，重放即得）
  return { conversation, workflowEvents, workflowTotal: wsEvents.length, goals: foldGoals(wsEvents), todos: foldTodos(wsEvents) }
}

/** 解析 limit：整型且 1..DEFAULT_PAGE_LIMIT（非法/0/负/超大 → 缺省 500）。
 *  AA-P2-2：分页保护不可被 `limit=999999999` 打穿，零封不被当成「空页」合法值。 */
export function limitParam(v: string | null): number {
  if (v === null || v.trim() === '') return DEFAULT_PAGE_LIMIT
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) return DEFAULT_PAGE_LIMIT
  return Math.min(n, DEFAULT_PAGE_LIMIT)
}

/** 解析 offset：整型且 ≥0（非法 → 0）；无上界——offset 出界自然空页，无害。 */
export function offsetParam(v: string | null): number {
  if (v === null || v.trim() === '') return 0
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/** 解析分页参数（AA-P2-2：limit 夹取；offset 语义宽松）——独立导出示可单测 */
export function parseAuditPaging(limitRaw: string | null, offsetRaw: string | null): AuditPaging {
  return { limit: limitParam(limitRaw), offset: offsetParam(offsetRaw) }
}

export function registerAuditRoutes(ctx: AuditCtx): void {
  route('GET', '/api/books/:name/audit', (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: '没有这本书：' + params['name'] })
    const bookName = params['name']!
    const bookRoot = join(ctx.workDir, entry.path)
    if (!ctx.userDataPath) {
      return reply(res, 200, { conversation: null, workflowEvents: [], workflowTotal: 0, goals: [], todos: [] })
    }

    // P3-13 + AA-P2-2：分页参数（limit/offset，默认每页 500 条截断；limit 夹取 1..500）——
    // 长书几万事件不再一次全量进响应，且客户端不可用超大 limit 打穿截断。
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams
    const paging = parseAuditPaging(q.get('limit'), q.get('offset'))

    // userDataPath 非空已确认 → store 必建库（openSessionStore 非惰性）
    const store = openSessionStore(ctx.userDataPath, bookRoot)!
    try {
      reply(res, 200, buildAuditView(store, bookName, bookRoot, paging))
    } finally {
      store.close()
    }
  })
}

