/**
 * 对话助手四端点（复审-0914-优化 D3，2026-09-14 修复批自 stream.ts 纯搬移）：
 * chat.send / books.chat.confirm / books.chat.regenerate / books.chat.clear。
 *
 * 搬移缘由：stream.ts 原五职责同居（SSE 记账/spawn 编排/watchdog/interrupt/auto-write/
 * chat 四端点，1097 行），chat 段与 SSE 零共享（仅复用 ensureSession/getDriver），
 * 独立成文件。chatEntryGateError 闸组 helper 仅 chat 段消费，随迁。
 * 唯一跨文件依赖 = forgetSseCount（stream.ts 的 per-book SSE 记账，chat.clear 清账）——
 * chat.ts → stream.ts 单向 import，无环。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { ensureSession, getDriver } from '../../../driver/index.js'
import { isSelfHealRunning, isChatEmbeddedSelfHealRunning } from '../../../ai/orchestrate/self-heal.js'
import { hasBackgroundTasks } from '../../../ai/orchestrate/background.js'
import { isChatRunning, resolveChatConfirm, clearChatHistory, sendChatMessage } from '../../../ai/orchestrate/chat.js'
import { isSpawnRunning } from '../../../ai/orchestrate/spawn-registry.js'
import { isReviewRunningForBook } from './review.js'
import { allHeldTaskGatesFor } from './audit.js'
import { forgetSseCount } from './stream.js'

interface ChatCtx {
  workDir: string | null
  userDataPath: string | null
}

/**
 * R0912-P3-⑤：chat.send / chat.regenerate 入口闸组单点化——两路此前各自多段近乎逐行
 * 复制（首检 / readJson 后中段复检 / ensureSession 后复检，历史上漂移过一次 R32-7），
 * 抽本 helper 统一；调用点保持原有检查段数与先后顺序，TOCTOU 复检语义逐位保真（每次
 * 调用即时取态：嵌套标记与各闸均为活查询，不缓存）。返回 null = 放行；非 null = 409
 * BUSY 文案。
 *
 * 闸组语义（沿革 R-9 / R70-5 / R76-12）：
 * - self-heal 闸 × R76-12 嵌套豁免：chat 的 write_chapter 工具在途时 isSelfHealRunning
 *   为真且 'rewrite' 任务闸被本会话工具持有，原样 409 会把作者的 steer 追加话拒之门外
 *   （写章是 chat 自己发起的，结束后续链正是 E1a 入队语义）——嵌套标记时放行，交
 *   sendChatMessage 原子判定入队；独立写稿（非嵌套）维持 409。
 * - spawn 闸（AI-1/M-2 互斥矩阵）：写手在途时对话（含嵌套生成工具）两路 runTask 互覆
 *   预算章块/草稿。
 * - 任务闸（R70-5，嵌套时豁免）：outline/lead-updates/onboard-ai/analyze 等分钟级任务
 *   在途时对话收尾与其产出互踩。R0912-P2-疑似：换 allHeldTaskGatesFor（books.ts
 *   busyGate 同款含跨进程面）——他进程分钟级任务在途不再放行。
 * - opts.taskGate = false：regenerate 的 readJson 后中段复检专用——该段历史上只查编排
 *   两闸（R32-7 引入时未含任务闸面），任务闸窗口由 ensureSession 后的终检覆盖，保真
 *   不改拒绝时序。
 */
function chatEntryGateError(bookName: string, opts?: { taskGate?: boolean }): string | null {
  const chatEmbeddedWrite = isChatEmbeddedSelfHealRunning(bookName)
  if (isSelfHealRunning(bookName) && !chatEmbeddedWrite) {
    return '本书正在全自动写章，先等它跑完或中断再对话'
  }
  if (isSpawnRunning(bookName)) {
    return '本书正在手动写稿，先等它跑完或中断再对话'
  }
  if ((opts?.taskGate ?? true) && !chatEmbeddedWrite) {
    const held = allHeldTaskGatesFor(bookName)
    if (held.length > 0) {
      return `本书有任务在跑（${held.join('、')}），先等它完成或中断再对话`
    }
  }
  return null
}

export function registerChatRoutes(ctx: ChatCtx): void {
  // 对话助手：fire-and-forget + SSE 回流（与 /spawn 同模式）
  // E2 示范：route schema 单点声明（defineRoute）——input 形状由 parse 声明，handler 拿类型化 input；
  // 校验失败统一 400 {error} 信封；新路由一律走 defineRoute，禁止加裸 route()。
  // 数据归属（E3 归类规则）：S2 事件子系统——会话写入经 events/store（chat-bridge 构造事件），本端点只触发编排。
  defineRoute('chat.send', {
    method: 'POST',
    path: '/api/books/:name/chat',
    parse: (raw) => {
      const body = (raw ?? {}) as Record<string, unknown>
      // R72-10（二十轮 D-5）：message 须为非空 string——原 String() 强转把数字/对象
      // 静默变串流入对话（掩盖调用方类型错误，与 documents 端点 typeof 口径不一致）
      const rawMessage = body['message']
      if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
        throw new Error('message 必填（须为非空字符串）')
      }
      const message = rawMessage.trim()
      if (message.length > 50_000) throw new Error('消息过长（上限 5 万字符）')
      // X-P2-12：chapter 非法值（如 "abc" → NaN）不放进 opts——下游 buildChatContext/工具
      // 会拿 NaN 找章，报错面目全非；入口即校验
      const rawChapter = body['chapter']
      const chapter = rawChapter === undefined || rawChapter === null ? undefined : Number(rawChapter)
      if (chapter !== undefined && (!Number.isInteger(chapter) || chapter < 1)) {
        throw new Error('chapter 需为正整数')
      }
      return { message, chapter }
    },
    handler: async ({ params, input }, _req, res) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const bookName = params['name']!
      if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到用户数据目录')
      // R-9（第十六轮）：chat 入口补 spawn/self-heal 反向互斥（闸组语义详见
      // chatEntryGateError 注释）。R0912-P3-⑤：闸组抽 helper 单点化（与 regenerate 同源）。
      const gateErr = chatEntryGateError(bookName)
      if (gateErr) return replyError(res, 409, 'BUSY', gateErr)

      const mainSession = await ensureSession(bookName, ctx.workDir!)
      // R-9：ensureSession await 后二次检查（对齐 /auto-write 的 N4 TOCTOU 收窄口径；
      // R76-12 嵌套豁免同首检口径——嵌套标记可能在 await 期间才落下）
      const gateErrRecheck = chatEntryGateError(bookName)
      if (gateErrRecheck) return replyError(res, 409, 'BUSY', gateErrRecheck)
      // E1a（steer）：对话运行中不再 409 拒绝，改为入队（当前轮结束自动续链）。
      // 二次检查（await 期间可能另一个请求已启动）在 sendChatMessage 内原子完成——running 判定与入队同临界区。
      const driver = getDriver()
      const outcome = sendChatMessage({
        driver,
        mainSession,
        userDataPath: ctx.userDataPath!,
        bookRoot: r.bookRoot,
        bookName,
        message: input.message,
        ...(input.chapter !== undefined ? { chapter: input.chapter } : {}),
      })

      reply(res, 200, { ok: true, queued: outcome === 'queued' })
    },
  })

  // 工具确认：作者点了确认/取消
  defineRoute('books.chat.confirm', {
    method: 'POST',
    path: '/api/books/:name/chat/confirm',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) return replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
    const bookName = params['name']!
    // R27-64（二十七轮）：补 resolveBook——chat 族（send/regenerate）都有书存在性
    // 校验，唯本端点漏挂：书名打错/书已删时落到下方 404「未找到待确认的工具调用」，
    // 语义误导排障（书不存在 ≠ 调用不存在）
    const r = resolveBook(ctx.workDir, bookName)
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const body = await readJson(req)
    const callId = String(body['callId'] ?? '')
    // R26-60（二十六轮）：确认旗标严格判定——原 Boolean() 强转把字符串 'false' / 0 以外
    // 的任意真值（如 'false'、'0'）都判成作者确认，前端序列化偏差即误放行工具调用
    const ok = body['ok'] === true
    if (!callId) return replyError(res, 400, 'BAD_INPUT', 'callId 必填')

    const found = resolveChatConfirm(bookName, callId, ok)
    if (!found) return replyError(res, 404, 'NOT_FOUND', '未找到待确认的工具调用（已超时或已取消）')
    reply(res, 200, { ok: true })
  },
  })

  // F1-P4：重新生成上一条回复——parentSeq = 触发 user 的全局 seq，branchId = 变体组
  defineRoute('books.chat.regenerate', {
    method: 'POST',
    path: '/api/books/:name/chat/regenerate',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const bookName = params['name']!
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到用户数据目录')
    // R-9（第十六轮）：regenerate 同款 spawn/self-heal 反向互斥（与 chat.send 口径一致）
    // R32-7（三十二轮）：补 R76-12 嵌套写章豁免——chat 自己的 write_chapter 工具在途时
    // isSelfHealRunning 为真且 'rewrite' 任务闸被本会话工具持有，原样 409 会把 regenerate
    // 拒之门外且文案误导（报「全自动写章进行中」，实为 chat 自身嵌套生成）。
    // R0912-P3-⑤：闸组抽 helper 单点化（与 chat.send 同源，语义详见 chatEntryGateError 注释）。
    const gateErr = chatEntryGateError(bookName)
    if (gateErr) return replyError(res, 409, 'BUSY', gateErr)
    const body = await readJson(req)
    const rawParentSeq = Number(body['parentSeq'])
    if (!Number.isInteger(rawParentSeq) || rawParentSeq < 1) return replyError(res, 400, 'BAD_INPUT', 'parentSeq 需为正整数')
    const branchId = String(body['branchId'] ?? '').trim()
    if (!branchId) return replyError(res, 400, 'BAD_INPUT', 'branchId 必填')
    const rawChapter = body['chapter']
    const chapter = rawChapter === undefined || rawChapter === null ? undefined : Number(rawChapter)
    if (chapter !== undefined && (!Number.isInteger(chapter) || chapter < 1)) return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')

    // R32-7：此处二次检查嵌套豁免（readJson await 期间嵌套标记可能才落下）。
    // R0912-P3-⑤：中段复检历史上只查编排两闸（R32-7 引入时未含任务闸面），以
    // taskGate:false 保真——任务闸窗口由 ensureSession 后的终检覆盖，不改拒绝时序。
    const gateErrMid = chatEntryGateError(bookName, { taskGate: false })
    if (gateErrMid) return replyError(res, 409, 'BUSY', gateErrMid)
    const mainSession = await ensureSession(bookName, ctx.workDir!)
    // Z-3（第五十八轮）：二次检查移到 ensureSession 之后（与 chat.send 完全同序）——
    // 此前排在 await 之前（注释却宣称「await 后二次检查」），让出窗口内他标签页 /spawn
    // 占闸启动写手，regenerate 续体无复查直接 sendChatMessage（内含嵌套生成工具）→
    // 双写手互覆草稿/预算章块（R-9 互斥矩阵要防的场景）
    // R32-7：复检同款嵌套豁免（嵌套标记可能在 await 期间才落下，同 chat.send R76-12）
    const gateErrRecheck = chatEntryGateError(bookName)
    if (gateErrRecheck) return replyError(res, 409, 'BUSY', gateErrRecheck)
    const driver = getDriver()
    const outcome = sendChatMessage({
      driver,
      mainSession,
      userDataPath: ctx.userDataPath!,
      bookRoot: r.bookRoot,
      bookName,
      regenerate: { parentSeq: rawParentSeq, branchId },
      ...(chapter !== undefined ? { chapter } : {}),
    })
    reply(res, 200, { ok: true, queued: outcome === 'queued' })
  },
  })

  // 清空本书对话历史（前端"清空对话"时调）
  defineRoute('books.chat.clear', {
    method: 'POST',
    path: '/api/books/:name/chat/clear',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) return replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
    const bookName = params['name']!
    if (isChatRunning(bookName)) return replyError(res, 409, 'BUSY', '对话进行中，请先停止再清空')
    // M-2（第六轮）：clearChatHistory 与 audit DELETE 同为双键清理（bookName + bookHash
    // 工作流会话），audit 侧五闸（dd-P3/hh-P1/第五轮）已收口，此处此前只配两道——
    // spawn 手动写稿 / self-heal 批量写稿 / task-gate 分钟级任务在途时清空同样清不彻底，
    // 且任务收尾的 step/llm-call 事件追加到已被删 session 的行上成孤儿。对齐补三闸。
    // R29-9（二十九轮）：换 allHeldTaskGatesFor（books.ts busyGate R75-5 同口径）——
    // 双进程下 B 进程分钟级任务在途时 A 进程清空对话同样放行清不彻底，现 409 拒清
    const held = allHeldTaskGatesFor(bookName)
    if (held.length > 0) {
      return replyError(res, 409, 'BUSY', `本书有任务在跑（${held.join('、')}），先等它完成后再清空对话`)
    }
    if (isSelfHealRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在自动写稿，先等它完成或中断后再清空对话')
    }
    if (isSpawnRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在生成（手动写稿），先等它完成或中断后再清空对话')
    }
    // 第九轮 M-1（对齐 audit DELETE 五闸收口）：三审在途时经 runSpec 向工作流会话追加
    // llm-call 事件——在途清空同样清不彻底，补同口径闸
    if (isReviewRunningForBook(bookName)) {
      return replyError(res, 409, 'BUSY', '本书三审进行中，先等它完成后再清空对话')
    }
    // 第五轮：fire-and-forget 后台任务（定稿摘要等）持 workspace 会话续写事件——
    // clearChatHistory 双键同清工作流侧，在途清空同样清不彻底，补同口径闸
    if (hasBackgroundTasks(bookName)) {
      return replyError(res, 409, 'BUSY', '本书有后台任务收尾中（如定稿摘要），稍等片刻再清空对话')
    }
    // 二轮复审（低级）：resolveBook 统一解析——旧 readBooks().find() 对不存在的书
    // 静默落「只清内存」假成功（200），事件库原样残留；现与全文件其余路由同 404 口径
    const r = resolveBook(ctx.workDir, bookName)
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    // F1-P1：清内存 + 清事件库
    // R34D-19（三十四轮）：clearChatHistory 转异步（事件库开库异步孪生）
    await clearChatHistory(bookName, ctx.userDataPath ?? undefined, r.bookRoot)
    // R-18（第十六轮）：清空对话 = 本书对话上下文整体销毁 → per-book SSE 计数一并清理
    forgetSseCount(bookName)
    reply(res, 200, { ok: true })
  },
  })
}
