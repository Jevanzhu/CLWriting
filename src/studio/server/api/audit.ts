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
import { resolveBookOrReply } from '../book-context.js'
import { openSessionStoreAsync, bookHash, type SessionStore } from '../../../events/store.js'
import { foldSurface } from '../../../events/projection.js'
import { foldGoals, foldTodos } from '../../../events/goal-state.js'
import { isChatRunning } from '../../../ai/orchestrate/chat.js'
import { isSelfHealRunning } from '../../../ai/orchestrate/self-heal.js'
import { hasBackgroundTasks } from '../../../ai/orchestrate/background.js'
import { isSpawnRunning } from './stream.js'
import { heldTaskGatesFor, crossProcessHeldTaskGatesFor } from './task-gate.js'
import { isReviewRunningForBook } from './review.js'
import type { ChatEvent, EventType, GoalSnapshot, SurfaceOp, Todo } from '../../../events/types.js'
import { SURFACE_EVENT_TYPES } from '../../../events/types.js'
import { errMsg } from '../../../log/index.js' // errMsg 收编（复审-0914-优化修复批）：错误文案三目单源

interface AuditCtx {
  workDir: string | null
  userDataPath: string | null
}

/** B402（0918四轮修复批）：foldSurface 实际消费的事件类型集——surface 三类 + replace
 *  载体 compaction/end（projection.ts foldSurface 对其余类型直落忽略）。流式读侧据此
 *  截留折叠输入，其余类型不再物化持有。 */
const FOLD_INPUT_TYPES: ReadonlySet<EventType> = new Set<EventType>([...SURFACE_EVENT_TYPES, 'compaction/end'])

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
interface AuditNode {
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
interface AuditConversation {
  events: AuditEvent[]
  /** P3-13：本页截断后的条数（与 eventsTotal 区分，前端可据此判断还有下一页） */
  eventsTotal: number
  modelVisible: AuditNode[]
  humanVisible: AuditNode[]
  shadowedCount: number
}

/** 分页参数（缺省 limit=500，offset=0） */
interface AuditPaging {
  limit: number
  offset: number
}

const DEFAULT_PAGE_LIMIT = 500

/** 审计视图（对话 + 工作流 + goal/todo 当前态），纯函数——route 薄接线 + 单测直喂 store */
export function buildAuditView(
  store: SessionStore,
  bookName: string,
  bookRoot: string,
  paging: AuditPaging = { limit: DEFAULT_PAGE_LIMIT, offset: 0 },
): { conversation: AuditConversation | null; workflowEvents: AuditEvent[]; workflowTotal: number; goals: GoalSnapshot[]; todos: Todo[] } {
  // ── 0918四轮修复批（B402）：全量物化改流式 iterateEvents ──
  // 原两次 store.listEvents 全量物化（含大载荷 llm/call 的 workflow 流逐行 JSON.parse
  // 成对象数组后只取一页）。改单趟流式：只持有①页窗口内条目（≤ limit）与②折叠实需
  // 的类型子集；响应形状逐字段不变（eventsTotal/workflowTotal 沿「可解析事件数」旧口径
  // 随流计数——不用 countEvents：骨架计数含坏行，坏行库上会偏离原值，流式计数零成本
  // 且逐位保真）。响应形状逐字段不变，既有 audit 测试全绿为验收面。
  const offset = paging.offset ?? 0
  const limit = paging.limit
  const inPage = (index: number): boolean => index >= offset && index < offset + limit
  // 对话会话（book = bookName）：surface 投影 + 遮蔽差异
  // 全量折叠语义必需（shadowedCount/首屏 visible 双投影/逐事件 shadowed 标记都依赖完整
  // 事件流重放，SV-2 口径不变）——流中只截留 foldSurface 实际消费的四类（SURFACE 三类 +
  // replace 载体 compaction/end），其余类型（session/turn 边界、tool/call 大载荷等）过站
  // 即弃不再持有。
  let convoTotal = 0
  const convoPage: ChatEvent[] = []
  const convoFold: ChatEvent[] = []
  for (const ev of store.iterateEvents(bookName)) {
    if (inPage(convoTotal)) convoPage.push(ev)
    if (FOLD_INPUT_TYPES.has(ev.type)) convoFold.push(ev)
    convoTotal++
  }
  let conversation: AuditConversation | null = null
  if (convoTotal > 0) {
    const nodes = foldSurface(convoFold)
    // M1（二轮复审）：shadowed 查表一次建 Set——此前每事件线性扫全部 nodes（O(events×nodes)，
    // 长书几万事件一次请求数十亿次比较，同步阻塞事件循环）；节点 seq 唯一，语义严格等价
    const shadowedSeqs = new Set<number>()
    for (const n of nodes) if (n.shadowed) shadowedSeqs.add(n.seq)
    // P3-13：events 全量载荷按页截断（长书几万事件不再一次全量进 HTTP 响应）；total 供分页。
    // SV-2（第七轮）：modelVisible/humanVisible 是「遮蔽差异」面板的全量对照数据（首屏需要
    // 完整列表），但「加载更多」的每页响应都在重发同一份全量投影（前端只追加 events、丢弃
    // conversation 字段）——后续页省略投影只带 events 切片，长书翻页不再全量出网。
    const firstPage = offset === 0
    conversation = {
      events: convoPage.map((e) => ({
        seq: e.seq,
        sessionId: e.sessionId,
        type: e.type,
        ...(e.surfaceOp !== undefined ? { surfaceOp: e.surfaceOp } : {}),
        shadowed: shadowedSeqs.has(e.seq),
        ...(e.sourceSeqs ? { sourceSeqs: e.sourceSeqs } : {}),
        data: e.data,
      })),
      eventsTotal: convoTotal,
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

  // 写作工作流（book = bookHash）：step/llm-call 链路事件（同上：只留页窗口条目；
  // goal/todo 折叠实需类型子集另路截留，foldGoals/foldTodos 内部本就按类型过滤）
  let wsTotal = 0
  const wsPage: ChatEvent[] = []
  const wsFold: ChatEvent[] = []
  for (const ev of store.iterateEvents(bookHash(bookRoot))) {
    if (inPage(wsTotal)) wsPage.push(ev)
    if (ev.type === 'goal/change' || ev.type === 'todo/write') wsFold.push(ev)
    wsTotal++
  }
  const workflowEvents: AuditEvent[] = wsPage.map((e) => ({
    seq: e.seq,
    sessionId: e.sessionId,
    type: e.type,
    ...(e.surfaceOp !== undefined ? { surfaceOp: e.surfaceOp } : {}),
    shadowed: false,
    ...(e.sourceSeqs ? { sourceSeqs: e.sourceSeqs } : {}),
    data: e.data,
  }))

  // F5：goal/todo 当前态（goal/todo 事件随 self-heal 落工作流会话，重放即得）
  return { conversation, workflowEvents, workflowTotal: wsTotal, goals: foldGoals(wsFold), todos: foldTodos(wsFold) }
}

/** 解析 limit：整型且 1..DEFAULT_PAGE_LIMIT（非法/0/负/超大 → 缺省 500）。
 *  AA-P2-2：分页保护不可被 `limit=999999999` 打穿，零封不被当成「空页」合法值。 */
function limitParam(v: string | null): number {
  if (v === null || v.trim() === '') return DEFAULT_PAGE_LIMIT
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) return DEFAULT_PAGE_LIMIT
  return Math.min(n, DEFAULT_PAGE_LIMIT)
}

/** 解析 offset：整型且 ≥0（非法 → 0）；无上界——offset 出界自然空页，无害。 */
function offsetParam(v: string | null): number {
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

/**
 * 重评二轮-P3-2（2026-09-13 全库源码重评二轮 GLM-5.3）：清对话（chat/clear）与清
 * 事件史（audit DELETE）共用的六闸拒清理由单源（null = 放行）。闸序沿革：dd-P3
 * （对话运行）→ hh-P1（task-gate 分钟级任务 + self-heal 批量写稿）→ 第九轮 M-1
 * （三审）→ 第五轮（后台收尾 + spawn 手动写稿）→ R29-9（task-gate 并入跨进程锁
 * 文件扫描）。原两处各自内联同组闸且只在入口查一次——openSessionStoreAsync /
 * clearChatHistory 内部的 await 让出窗口内新起任务时闸检已过、清库照走，任务收尾
 * 继续向已清 session 追加事件（清不彻底 + 事件复活）。现入口与 await 后清库前各查
 * 一次（本函数两用），消息模板「……后再${action}」（audit = 清除事件史 /
 * stream = 清空对话）。
 */
export function chatClearGateReason(bookName: string, action: string): string | null {
  if (isChatRunning(bookName)) return `本书对话仍在运行，先停止后再${action}`
  const held = allHeldTaskGatesFor(bookName)
  if (held.length > 0) return `本书有任务在跑（${held.join('、')}），先等它完成后再${action}`
  if (isSelfHealRunning(bookName)) return `本书正在自动写稿，先等它完成或中断后再${action}`
  if (isReviewRunningForBook(bookName)) return `本书三审进行中，先等它完成后再${action}`
  if (hasBackgroundTasks(bookName)) return `本书有后台任务收尾中（如定稿摘要），稍等片刻后再${action}`
  if (isSpawnRunning(bookName)) return `本书正在生成（手动写稿），先等它完成或中断后再${action}`
  return null
}

export function registerAuditRoutes(ctx: AuditCtx): void {
  defineRoute('books.audit.get', {
    method: 'GET',
    path: '/api/books/:name/audit',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return
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

    // userDataPath 非空已确认 → store 必建库（openSessionStoreAsync 非惰性）
    // R62-43：userDataPath 空返回 null（上方已分流）；极端下仍可能 null → 显式错误
    // 信封（不再 ! 断言，此前静默 TypeError 崩路由）
    // IR-8（独立重评 2026-09-02）勘误：库损坏/权限等首开失败是**抛错**不是返回 null
    //（原注释失实，裸抛落 defineRoute 兜底 500 泛化文案）→ 显式收编结构化 500，
    // e.message 人话透传（含 IR-2 损坏分类的可行动指引；经统一脱敏出口）
    // R34D-19（三十四轮）：开库走异步孪生（首开锁等待不阻塞服务事件循环）
    let store: SessionStore | null
    try {
      store = await openSessionStoreAsync(ctx.userDataPath, bookRoot)
    } catch (e) {
      return replyError(
        res,
        500,
        'STORE_UNAVAILABLE',
        `事件库不可用（无法打开会话存储）：${errMsg(e)}`,
      )
    }
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
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return
    // 重评二轮-P3-2：六闸收编 chatClearGateReason 单源（沿革注释见其头注——dd-P3 /
    // hh-P1 / 第九轮 M-1 / 第五轮 / R29-9），入口首查 + 开库让出后复查（见下）两用
    const gate = chatClearGateReason(params['name']!, '清除事件史')
    if (gate) return replyError(res, 409, 'BUSY', gate)
    const bookRoot = r.bookRoot
    if (!ctx.userDataPath) return reply(res, 200, { ok: true }) // 无事件库模式（浏览器版）no-op
    // R62-43：userDataPath 空 no-op（上方已分流）；极端下仍可能 null → 显式错误信封
    // IR-8（独立重评 2026-09-02）勘误：库损坏/权限等首开失败是**抛错**不是返回 null
    //（原注释失实，裸抛落 defineRoute 兜底 500 泛化文案）→ 显式收编结构化 500，
    // e.message 人话透传（含 IR-2 损坏分类的可行动指引；经统一脱敏出口）
    // R34D-19（三十四轮）：开库走异步孪生（首开锁等待不阻塞服务事件循环）
    let store: SessionStore | null
    try {
      store = await openSessionStoreAsync(ctx.userDataPath, bookRoot)
    } catch (e) {
      return replyError(
        res,
        500,
        'STORE_UNAVAILABLE',
        `事件库不可用（无法打开会话存储）：${errMsg(e)}`,
      )
    }
    if (!store) return replyError(res, 500, 'STORE_UNAVAILABLE', '事件库不可用（无法打开会话存储）')
    try {
      // 重评二轮-P3-2：开库 await 让出窗口内新起任务（chat/spawn/self-heal/三审/
      // task-gate/后台收尾）复查——拦在 clearBooks 之前，任务收尾不再向已清 session
      // 追加事件（清不彻底 + 事件复活）；finally 侧 store.close() 照常收口
      const recheck = chatClearGateReason(params['name']!, '清除事件史')
      if (recheck) return replyError(res, 409, 'BUSY', recheck)
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

