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
import { defineRoute } from './schema.js'
import { reply, replyError, parseRequestUrl } from '../http.js'
import { resolveBook } from '../book-context.js'
import { openSessionStore, bookHash, type SessionStore } from '../../../events/store.js'
import { foldSurface } from '../../../events/projection.js'
import { foldGoals, foldTodos } from '../../../events/goal-state.js'
import { isChatRunning } from '../../../ai/orchestrate/chat.js'
import { isSelfHealRunning } from '../../../ai/orchestrate/self-heal.js'
import { hasBackgroundTasks } from '../../../ai/orchestrate/background.js'
import { isSpawnRunning } from './stream.js'
import { heldTaskGatesFor, crossProcessHeldTaskGatesFor } from './task-gate.js'
import { isReviewRunningForBook } from './review.js'
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
    // M1（二轮复审）：shadowed 查表一次建 Set——此前每事件线性扫全部 nodes（O(events×nodes)，
    // 长书几万事件一次请求数十亿次比较，同步阻塞事件循环）；节点 seq 唯一，语义严格等价
    const shadowedSeqs = new Set<number>()
    for (const n of nodes) if (n.shadowed) shadowedSeqs.add(n.seq)
    // P3-13：events 全量载荷按页截断（长书几万事件不再一次全量进 HTTP 响应）；total 供分页。
    // 低级项（第六轮）：先切片再投影——原 map 全量造投影对象后丢弃大半，长书每请求白造几万对象。
    // SV-2（第七轮）：modelVisible/humanVisible 是「遮蔽差异」面板的全量对照数据（首屏需要
    // 完整列表），但「加载更多」的每页响应都在重发同一份全量投影（前端只追加 events、丢弃
    // conversation 字段）——后续页省略投影只带 events 切片，长书翻页不再全量出网。
    const firstPage = (paging.offset ?? 0) === 0
    conversation = {
      events: pageSlice(convoEvents, paging).map((e) => ({
        seq: e.seq,
        sessionId: e.sessionId,
        type: e.type,
        ...(e.surfaceOp !== undefined ? { surfaceOp: e.surfaceOp } : {}),
        shadowed: shadowedSeqs.has(e.seq),
        ...(e.sourceSeqs ? { sourceSeqs: e.sourceSeqs } : {}),
        data: e.data,
      })),
      eventsTotal: convoEvents.length,
      modelVisible: firstPage
        ? nodes
            .filter((n) => !n.shadowed)
            .map((n) => ({ seq: n.seq, kind: n.kind, role: n.role, shadowed: false, preview: toPreview(n.content) }))
        : [],
      humanVisible: firstPage
        ? nodes.map((n) => ({ seq: n.seq, kind: n.kind, role: n.role, shadowed: n.shadowed, preview: toPreview(n.content) }))
        : [],
      shadowedCount: nodes.filter((n) => n.shadowed).length,
    }
  }

  // 写作工作流（book = bookHash）：step/llm-call 链路事件（同上：先切片再投影）
  const wsEvents = store.listEvents(bookHash(bookRoot))
  const workflowEvents: AuditEvent[] = pageSlice(wsEvents, paging).map((e) => ({
    seq: e.seq,
    sessionId: e.sessionId,
    type: e.type,
    ...(e.surfaceOp !== undefined ? { surfaceOp: e.surfaceOp } : {}),
    shadowed: false,
    ...(e.sourceSeqs ? { sourceSeqs: e.sourceSeqs } : {}),
    data: e.data,
  }))

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

/**
 * R29-9（二十九轮）：任务闸「进程内 + 跨进程」合并查询——books.ts busyGate（R75-5）
 * 同口径。heldTaskGatesFor 只看进程内 Set，双进程形态（dev-api/脚本与 GUI 并存）下
 * B 进程分钟级任务在途时，A 进程的清史（DELETE /audit）/清空对话（chat/clear）看不见
 * 该闸，放行清库后任务收尾继续向已清 session 追加事件（清不彻底 + 事件复活）。并入
 * crossProcessHeldTaskGatesFor 锁文件扫描（陈锁由锁原语语义剔除，不误伤）；Set 去重
 * 防本进程闸两侧双报。模式已在 books/audit/stream 三处重复 → 抽本地 helper（放本文件
 * 导出、stream.ts 引用，不动 task-gate.ts 共享面）。
 */
export function allHeldTaskGatesFor(bookName: string): string[] {
  return [...new Set([...heldTaskGatesFor(bookName), ...crossProcessHeldTaskGatesFor(bookName)])]
}

export function registerAuditRoutes(ctx: AuditCtx): void {
  defineRoute('books.audit.get', {
    method: 'GET',
    path: '/api/books/:name/audit',
    handler: ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const bookName = params['name']!
    const bookRoot = r.bookRoot
    if (!ctx.userDataPath) {
      return reply(res, 200, { conversation: null, workflowEvents: [], workflowTotal: 0, goals: [], todos: [] })
    }

    // P3-13 + AA-P2-2：分页参数（limit/offset，默认每页 500 条截断；limit 夹取 1..500）——
    // 长书几万事件不再一次全量进响应，且客户端不可用超大 limit 打穿截断。
    // R-19（第十六轮）：parseRequestUrl 统一解析（Q-1/N-3 口径）——畸形 URL → 400 BAD_INPUT
    const url = parseRequestUrl(req)
    if (!url) return replyError(res, 400, 'BAD_INPUT', 'bad request')
    const q = url.searchParams
    const paging = parseAuditPaging(q.get('limit'), q.get('offset'))

    // userDataPath 非空已确认 → store 必建库（openSessionStore 非惰性）
    // R62-43：库损坏/权限等极端下 openSessionStore 仍可能返回 null——不再用 ! 断言，
    // 显式错误信封（此前静默 TypeError 崩路由）
    const store = openSessionStore(ctx.userDataPath, bookRoot)
    if (!store) return replyError(res, 500, 'STORE_UNAVAILABLE', '事件库不可用（无法打开会话存储）')
    try {
      reply(res, 200, buildAuditView(store, bookName, bookRoot, paging))
    } finally {
      store.close()
    }
  },
  })

  // 事件保留定版（2026-08-16 拍板：全量保留 + 手动清理）：每书事件史清除入口。
  // 对话会话（book=bookName）与工作流会话（book=bookHash）同库不同 book 键——两侧都清；
  // 事件是 append-only 审计数据，清除是作者显式销毁动作，前端二次确认后才调本端点。
  defineRoute('books.audit.delete', {
    method: 'DELETE',
    path: '/api/books/:name/audit',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    // dd-P3：对话运行中拒清（与 chat/clear 同口径）——清库后 chat 继续追加事件，清不彻底
    if (isChatRunning(params['name']!)) {
      return replyError(res, 409, 'BUSY', '本书对话仍在运行，先停止后再清除事件史')
    }
    // hh-P1（同族缺口）：task-gate 分钟级任务与 self-heal 批量写稿都会续写事件库——
    // 运行中清库同样「清不彻底」（任务收尾继续追加），补齐与 chat 相同的拒清口径。
    // R29-9（二十九轮）：换 allHeldTaskGatesFor（books.ts busyGate R75-5 同口径）——
    // 进程内闸并入跨进程锁文件扫描，双进程下 B 进程分钟级任务在途时 A 进程清史同样 409
    const held = allHeldTaskGatesFor(params['name']!)
    if (held.length > 0) {
      return replyError(res, 409, 'BUSY', `本书有任务在跑（${held.join('、')}），先等它完成后再清除事件史`)
    }
    if (isSelfHealRunning(params['name']!)) {
      return replyError(res, 409, 'BUSY', '本书正在自动写稿，先等它完成或中断后再清除事件史')
    }
    // 第九轮 M-1（busyGate 家族同族缺口）：三审是分钟级长任务，经 runSpec 追加 llm-call
    // 事件并写 review 信封——在途清库同样「清不彻底」（任务收尾事件复活到已清 session）
    if (isReviewRunningForBook(params['name']!)) {
      return replyError(res, 409, 'BUSY', '本书三审进行中，先等它完成后再清除事件史')
    }
    // 第五轮：fire-and-forget 后台任务（定稿章摘要等）与 spawn 手动写稿同样向工作流
    // 会话追加事件——在途清除会「清不彻底」（任务收尾事件复活），补齐同口径两闸
    if (hasBackgroundTasks(params['name']!)) {
      return replyError(res, 409, 'BUSY', '本书有后台任务收尾中（如定稿摘要），稍等片刻再清除事件史')
    }
    if (isSpawnRunning(params['name']!)) {
      return replyError(res, 409, 'BUSY', '本书正在生成（手动写稿），先等它完成或中断后再清除事件史')
    }
    const bookRoot = r.bookRoot
    if (!ctx.userDataPath) return reply(res, 200, { ok: true }) // 无事件库模式（浏览器版）no-op
    // R62-43：库损坏/权限等极端下 openSessionStore 仍可能返回 null——不再用 ! 断言，
    // 显式错误信封（此前静默 TypeError 崩路由）
    const store = openSessionStore(ctx.userDataPath, bookRoot)
    if (!store) return replyError(res, 500, 'STORE_UNAVAILABLE', '事件库不可用（无法打开会话存储）')
    try {
      // 低级项（第六轮）：双键单事务（clearBooks）——两次 clearBook 各自事务，
      // 第二键失败时对话侧已提交、工作流侧残留，清除一半
      store.clearBooks([params['name']!, bookHash(bookRoot)])
      reply(res, 200, { ok: true })
    } finally {
      store.close()
    }
  },
  })
}

