/**
 * SSE 端点：GUI 订阅事件流 + 触发生成。
 *
 * GET  /api/books/:name/stream     → SSE（订阅 driver.stream，持续推送 DriverEvent）
 * POST /api/books/:name/spawn      → 触发写稿（generateText + writerSystem，fire-and-forget + SSE 回流）
 * POST /api/books/:name/interrupt  → 中断生成 + 停自愈编排
 * POST /api/books/:name/auto-write → 全自动写章（写稿→机检→红则重写闭环，body {chapter}）
 *
 * SSE / interrupt / auto-write 经 driver session；/spawn 走 gen.ts generateText + provider 直连。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readBooks } from '../../../install/books.js'
import { ensureSession, getDriver } from '../../../driver/index.js'
import type { DriverEvent, Session, StudioDriver } from '../../../driver/index.js'
import { abortSelfHeal, isSelfHealRunning, runSelfHeal } from '../../../ai/orchestrate/self-heal.js'
import { isChatRunning, abortChat, resolveChatConfirm, clearChatHistory, sendChatMessage } from '../../../ai/orchestrate/chat.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { streamSpec } from '../../../ai/tasks/specs.js'
import { readKind } from '../book-context.js'
import { redactSecret } from '../../../ai/provider/redact.js' // P2-4：API 错误脱敏
import { resolveTier } from '../../../ai/provider/index.js'
import { resolveModelPricing, computeCallCost } from '../../../ai/pricing.js'
import { safeTokenCompare } from '../http.js'

interface StreamCtx {
  workDir: string | null
  userDataPath: string | null
  /** GET SSE 端点 token 校验用（EventSource 不走 isWrite 拦截） */
  studioToken: string
}

// P2-2：per-book SSE 连接计数（防多标签页耗尽 FD）
const sseConnections = new Map<string, number>()
const MAX_SSE_PER_BOOK = 5

// RB-SV-P2-1：per-book spawn 运行闸（与 /auto-write 的 self-heal 闸同模式）——
// 双标签页时序窗口并发双 spawn 会互相覆写草稿回流。占位在首个 await 前同步完成
// （比 auto-write 的「检查→await→二次检查」更严，无 TOCTOU 窗口），终态 finally 释放。
const spawnRunning = new Map<string, true>()

export function isSpawnRunning(bookName: string): boolean {
  return spawnRunning.has(bookName)
}

/** 测试用：直接置/清 spawn 运行闸（并发 409 用例的确定性夹具，同 __clearDocumentServices 风格）。 */
export function __setSpawnRunning(bookName: string, running: boolean): void {
  if (running) spawnRunning.set(bookName, true)
  else spawnRunning.delete(bookName)
}

/**
 * fire-and-forget 写稿：产物经 runTask 统一编排（mock/provider/中断/错误文案），
 * text 增量经 driver.emit 推 SSE。替代旧 driver.spawnRole 路径。
 * P1-2：ctrl 经 registerCtrl 交给 driver——interrupt() 可 abort 真实请求，isRunning() 判在途。
 */
async function runWriterSpawn(opts: {
  driver: StudioDriver
  mainSession: Session
  userDataPath: string | null
  bookRoot: string
  prompt: string
  role: string
}): Promise<void> {
  const emit = (ev: DriverEvent): void => {
    opts.driver.emit?.(opts.mainSession, ev)
  }

  // 通知前端：生成开始（前端清空旧正文 + 设 running=true）
  emit({ type: 'role_spawn', role: opts.role, parentToolUseId: `tu-${Date.now()}` })

  // mock 快路：emit 模拟事件序列（runTask 的 mockText 只返回值、不透出事件流，故 mock 独立处理）
  if (process.env['CLWRITING_DRIVER'] === 'mock') {
    const mockText = `【mock · ${opts.role}】这是 mock 的模拟写稿产出。\n`
    for (let i = 0; i < mockText.length; i += 12) {
      emit({ type: 'text', text: mockText.slice(i, i + 12), role: opts.role })
    }
    emit({ type: 'usage', cost: 0.0001, tokens: 120 })
    emit({ type: 'done', cost: 0.0001, usage: 120, reason: 'success' })
    return
  }

  const kind = readKind(opts.bookRoot)
  // X-P2-11：登记的 ctrl 在终态注销——isRunning 归 false（此前 done 后仍登记，SSE 快照假报「生成中」）
  let registered: AbortController | null = null
  try {
    const out = await runSpec(streamSpec(opts.role, kind), {
      userDataPath: opts.userDataPath,
      bookRoot: opts.bookRoot,
      userPrompt: opts.prompt,
      register: (ctrl) => {
        registered = ctrl
        opts.driver.registerCtrl?.(opts.mainSession, ctrl)
      },
      onReset: () => emit({ type: 'text_reset' }),
      onText: (delta) => emit({ type: 'text', text: delta, role: opts.role }),
    })

    if (out.ok) {
      // B-3：max_tokens 截断 → 警告（落盘保留，但让作者知道原因）
      if (out.data.stopReason === 'max_tokens') {
        emit({ type: 'warning', message: '产出达到长度上限被截断，建议调高单次输出上限' })
      }
      // D2（批 5）：有价格表算单次金额（input+output 按写稿模型四档分计），
      // 未配价省略 cost 字段——不再发恒 0（mock 遗留口径修正）
      const model = resolveTier(opts.userDataPath, 'creative').model
      const pricing = model ? resolveModelPricing(opts.userDataPath, model) : null
      const cost = out.usage && pricing
        ? computeCallCost(pricing, {
            inputTokens: out.usage.inputTokens,
            outputTokens: out.usage.outputTokens,
            ...(out.usage.cacheReadTokens !== undefined ? { cacheReadTokens: out.usage.cacheReadTokens } : {}),
            ...(out.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: out.usage.cacheWriteTokens } : {}),
          })
        : null
      emit({ type: 'done', usage: out.usage?.outputTokens ?? 0, reason: 'success', ...(cost !== null ? { cost } : {}) })
    } else {
      emit({ type: 'error', kind: 'provider', message: out.error, recoverable: false })
    }
  } finally {
    if (registered) opts.driver.unregisterCtrl?.(opts.mainSession, registered)
  }
}

/** fire-and-forget 兜底：编排器 try 外同步异常推 SSE error（防 unhandled rejection 崩进程致全部 SSE 断连） */
function emitSpawnError(driver: StudioDriver, session: Session, e: unknown): void {
  driver.emit?.(session, {
    type: 'error',
    kind: 'provider',
    // P2-4：API 错误脱敏——SDK 报错 message 可能含 API Key 痕迹
    message: redactSecret(e instanceof Error ? e.message : String(e)),
    recoverable: false,
  })
}

export function registerStreamRoutes(ctx: StreamCtx): void {
  // SSE 订阅 driver 事件流
  defineRoute('books.stream', {
    method: 'GET',
    path: '/api/books/:name/stream',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    // P2-2：per-book 连接数限制
    const sseName = params['name']!
    const conns = sseConnections.get(sseName) ?? 0
    if (conns >= MAX_SSE_PER_BOOK) {
      // hh §八-12：SSE 错误路径也走统一 JSON 信封（原裸文本 'too many connections'）——
      // EventSource API 不暴露 body 不受影响，curl/测试可见 code 机器码
      replyError(res, 429, 'BUSY', '本书 SSE 连接数已达上限，请关闭多余的标签页/窗口')
      return
    }
    if (!ctx.workDir) {
      replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
      return
    }
    const bookR = resolveBook(ctx.workDir, params['name'])
    if ('error' in bookR) {
      replyError(res, bookR.status, bookR.code, bookR.error)
      return
    }
    // GET 端点 token 校验：EventSource 不走 isWrite 拦截，单独校 query token。
    // ee-P2-12 口径修正（2026-08-17 拍板）：本机进程=同信任域——本地进程 GET /boot 即可拿
    // token，此处不承诺防本机进程；token 的实际作用是把 SSE 可订阅面收敛到拿到 boot 的
    // 客户端，配合 Host/Origin 校验（server/index.ts）防远端网页窃听创作内容。
    const queryToken = new URL(req.url ?? '', 'http://localhost').searchParams.get('token') ?? undefined
    if (!safeTokenCompare(queryToken, ctx.studioToken)) {
      replyError(res, 403, 'FORBIDDEN', 'forbidden')
      return
    }
    // 校验通过后才递增连接计数（P1-1：防 early return 路径泄漏计数器致 DoS）
    sseConnections.set(sseName, conns + 1)
    // close 回调注册前移至 ensureSession 之前：ensureSession 可抛异常，
    // 若 close 回调在其后才注册 → 计数器泄漏（连遭 DoS 上限）
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let iter: AsyncGenerator<DriverEvent> | undefined
    req.on('close', () => {
      if (heartbeat) clearInterval(heartbeat)
      const c = sseConnections.get(sseName)
      if (c !== undefined) sseConnections.set(sseName, Math.max(0, c - 1))
      if (iter) void iter.return(undefined)
      // E1c（后台继续，cherry backgroundMode:'continue'）：最后一个客户端断开不再 abort 编排器——
      // 生成后台跑完，重连经 sync 快照 + ring buffer 迟到回放（E1b）恢复现场。
      // 显式停止仍走 POST /interrupt（用户主动取消）。
    })
    // session.cwd = workDir(角色 agents 在 workDir/.claude/agents,init generateRoleShells 生成处)
    const session = await ensureSession(params['name']!, ctx.workDir)
    const driver = getDriver('cc')

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // ACAO 由全局 CORS 白名单统一设置(index.ts);不再覆写为 *,防跨站订阅 driver 流(创作内容泄露)
    })

    // 连接建立即补发运行态快照:刷新/新标签会错过 init 事件(channel 消费即弃),
    // 无快照则前端 running 假空闲 → 生成中误显「可生成」可再触发 spawn
    res.write(
      `data: ${JSON.stringify({ type: 'sync', running: driver.isRunning?.(session) ?? false, chatRunning: isChatRunning(params['name']!) })}\n\n`,
    )

    // driver.stream 实现为 async generator（mock / cc 均从 channel 推事件）
    iter = driver.stream(session) as AsyncGenerator<DriverEvent>
    // 客户端断开后写已关闭 socket 会抛错——统一守卫（writableEnded / destroyed）
    const safeWrite = (chunk: string): void => {
      if (!res.writableEnded && !res.destroyed) res.write(chunk)
    }
    // K5：心跳保活（防代理/浏览器 30-60s 无数据超时断连）
    heartbeat = setInterval(() => safeWrite(': heartbeat\n\n'), 30_000)
    try {
      for await (const ev of iter) {
        safeWrite(`data: ${JSON.stringify(ev)}\n\n`)
      }
    } catch (e) {
      safeWrite(
        `data: ${JSON.stringify({
          type: 'error',
          kind: 'stream',
          message: redactSecret(e instanceof Error ? e.message : String(e)),
          recoverable: false,
        })}\n\n`,
      )
    }
    clearInterval(heartbeat)
    if (!res.writableEnded) res.end()
  },
  })

  // 触发写稿：generateText + writerSystem，fire-and-forget + SSE 回流
  defineRoute('books.spawn', {
    method: 'POST',
    path: '/api/books/:name/spawn',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    // resolveBook 成功 = workDir 非空（null 已在其 error 分支 NO_WORKDIR 覆盖）——
    // 本文件后续 ctx.workDir! 断言据此成立（ensureSession 的 session.cwd 用 workDir 而非 bookRoot）
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)

    // RB-SV-P2-1：并发闸——同步占位（无 TOCTOU），未实际启动的路径 finally 释放防泄漏
    const bookName = params['name']!
    if (spawnRunning.has(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在生成，先等它跑完或中断')
    }
    // dd-P2：与全自动写章互斥——/auto-write 已查 spawnRunning，反向此前缺失：
    // self-heal 运行中仍接受 /spawn = 两个写手并发流式产出、落盘互相覆写草稿
    if (isSelfHealRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在全自动写章，先等它跑完或中断')
    }
    spawnRunning.set(bookName, true)
    let launched = false
    try {
      const body = await readJson(req)
      const role = typeof body['role'] === 'string' ? (body['role'] as string) : 'writer'
      const prompt = typeof body['prompt'] === 'string' ? (body['prompt'] as string) : ''
      // P0-3：拒空 prompt——空包只有 system prompt，产出与本书无关；调用方应先拉 /draft-prompt
      if (!prompt.trim()) {
        return replyError(res, 400, 'BAD_INPUT', 'prompt 不能为空（请先拉取 /draft-prompt 组写稿上下文）')
      }
      if (prompt.length > 100_000) {
        return replyError(res, 400, 'BAD_INPUT', 'prompt 过长（上限 10 万字符）')
      }

      const mainSession = await ensureSession(bookName, ctx.workDir!)
      const driver = getDriver('cc')
      launched = true
      // fire-and-forget：generateText 期间 text 增量经 driver.emit → SSE 回流；
      // 终态（含失败/中断）释放并发闸
      void runWriterSpawn({
        driver,
        mainSession,
        userDataPath: ctx.userDataPath,
        bookRoot: r.bookRoot,
        prompt,
        role,
      })
        .catch((e) => emitSpawnError(driver, mainSession, e))
        .finally(() => spawnRunning.delete(bookName))

      reply(res, 200, { ok: true, role })
    } finally {
      if (!launched) spawnRunning.delete(bookName)
    }
  },
  })

  // 中断当前生成：AbortController.abort() + 推 interrupted，session 保留可再 spawn
  defineRoute('books.interrupt', {
    method: 'POST',
    path: '/api/books/:name/interrupt',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const bookName = params['name']!
    // 先停自愈编排 + 对话编排
    abortSelfHeal(bookName)
    abortChat(bookName)
    const session = await ensureSession(bookName, ctx.workDir!)
    const driver = getDriver('cc')
    if (driver.interrupt) driver.interrupt(session)
    reply(res, 200, { ok: true })
  },
  })

  // 全自动写章(红项自愈闭环):AI 写稿 → 机检 → 红则自动退回重写 → 全绿或触顶交作者。
  // fire-and-forget(与 /spawn 同风格):编排最长可跑十几分钟,进度全程经主 session SSE 回流。
  defineRoute('books.auto-write', {
    method: 'POST',
    path: '/api/books/:name/auto-write',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const bookName = params['name']!
    if (!ctx.userDataPath) return replyError(res, 400, 'NO_USERDATA', '未定位到用户数据目录')
    // 并发保护（防御双闸之一，Z-P2-5 起与 driver.isRunning 并存）：本闸是编排级内存锁，
    // 覆盖 self-heal 完整生命周期——机检/账本草稿等阶段无在途 LLM 请求，driver.isRunning
    // 仍为 false，只有本闸拦得住重复触发（两个编排器会互相覆写草稿）。生成期两闸重叠冗余，
    // 保留无害：登记受 /interrupt 注销影响存在时序窗口，内存闸始终是可靠口径。
    if (isSelfHealRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在全自动写章,先等它跑完或中断')
    }

    const body = await readJson(req)
    const chapter = Number(body['chapter'])
    if (!Number.isInteger(chapter) || chapter < 1) {
      return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')
    }
    // P2-3：批量连写——batchSize 1-20，有值则生成连续章号序列（中途红项触顶停当前章，不续后续）
    const rawBatch = body['batchSize']
    const batchSize = rawBatch === undefined ? 1 : Number(rawBatch)
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) {
      return replyError(res, 400, 'BAD_INPUT', 'batchSize 需为 1-20 的整数')
    }
    const chapters = batchSize > 1 ? Array.from({ length: batchSize }, (_, i) => chapter + i) : undefined

    // session.cwd = workDir(角色 agents 在 workDir/.claude/agents)
    const mainSession = await ensureSession(bookName, ctx.workDir!)
    // 二次检查（await 期间可能另一个请求已启动）——N4 TOCTOU 收窄
    if (isSelfHealRunning(bookName)) {
      return replyError(res, 409, 'BUSY', '本书正在全自动写章，先等它跑完或中断')
    }
    const driver = getDriver('cc')
    // Z-P2-5：self-heal 的 ctrl 登记 driver（与 /spawn 的 runWriterSpawn 同款接线）——
    // 生成期 isRunning() 真值（SSE sync 快照此前假空闲，前端可误触 /spawn 互相覆写草稿），
    // /interrupt 的 driver.interrupt() 也能直接 abort 在途请求（与 abortSelfHeal 双保险）。
    // X-P2-11：终态注销（finally）——防 done 后快照仍报「生成中」。
    let registered: AbortController | null = null
    void runSelfHeal({
      driver,
      mainSession,
      userDataPath: ctx.userDataPath!,
      cwd: ctx.workDir!,
      bookRoot: r.bookRoot,
      bookName,
      chapter,
      ...(chapters ? { chapters } : {}),
      register: (c) => {
        registered = c
        driver.registerCtrl?.(mainSession, c)
      },
    })
      .catch((e) => emitSpawnError(driver, mainSession, e))
      .finally(() => {
        if (registered) driver.unregisterCtrl?.(mainSession, registered)
      })

    reply(res, 200, { ok: true, chapter, ...(batchSize > 1 ? { batchSize, chapters } : {}) })
  },
  })

  // 对话助手：fire-and-forget + SSE 回流（与 /spawn 同模式）
  // E2 示范：route schema 单点声明（defineRoute）——input 形状由 parse 声明，handler 拿类型化 input；
  // 校验失败统一 400 {error} 信封；新路由一律走 defineRoute，禁止加裸 route()。
  // 数据归属（E3 归类规则）：S2 事件子系统——会话写入经 events/store（chat-bridge 构造事件），本端点只触发编排。
  defineRoute('chat.send', {
    method: 'POST',
    path: '/api/books/:name/chat',
    parse: (raw) => {
      const body = (raw ?? {}) as Record<string, unknown>
      const message = String(body['message'] ?? '').trim()
      if (!message) throw new Error('message 必填')
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

      const mainSession = await ensureSession(bookName, ctx.workDir!)
      // E1a（steer）：对话运行中不再 409 拒绝，改为入队（当前轮结束自动续链）。
      // 二次检查（await 期间可能另一个请求已启动）在 sendChatMessage 内原子完成——running 判定与入队同临界区。
      const driver = getDriver('cc')
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
    const body = await readJson(req)
    const callId = String(body['callId'] ?? '')
    const ok = Boolean(body['ok'])
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
    const body = await readJson(req)
    const rawParentSeq = Number(body['parentSeq'])
    if (!Number.isInteger(rawParentSeq) || rawParentSeq < 1) return replyError(res, 400, 'BAD_INPUT', 'parentSeq 需为正整数')
    const branchId = String(body['branchId'] ?? '').trim()
    if (!branchId) return replyError(res, 400, 'BAD_INPUT', 'branchId 必填')
    const rawChapter = body['chapter']
    const chapter = rawChapter === undefined || rawChapter === null ? undefined : Number(rawChapter)
    if (chapter !== undefined && (!Number.isInteger(chapter) || chapter < 1)) return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')

    const mainSession = await ensureSession(bookName, ctx.workDir!)
    const driver = getDriver('cc')
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
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) return replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
    const bookName = params['name']!
    if (isChatRunning(bookName)) return replyError(res, 409, 'BUSY', '对话进行中，请先停止再清空')
    // F1-P1：清内存 + 清事件库（userData/书路径缺失时只清内存）
    const entry = readBooks(ctx.workDir).find((b) => b.name === bookName)
    clearChatHistory(bookName, ctx.userDataPath ?? undefined, entry ? join(ctx.workDir, entry.path) : undefined)
    reply(res, 200, { ok: true })
  },
  })
}
