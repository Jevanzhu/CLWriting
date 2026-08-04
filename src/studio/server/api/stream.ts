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
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { ensureSession, getDriver } from '../../../driver/index.js'
import type { DriverEvent, Session, StudioDriver } from '../../../driver/index.js'
import { abortSelfHeal, isSelfHealRunning, runSelfHeal } from '../../../ai/orchestrate/self-heal.js'
import { runChat, isChatRunning, abortChat, resolveChatConfirm } from '../../../ai/orchestrate/chat.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { streamSpec } from '../../../ai/tasks/specs.js'
import { readKind } from '../book-context.js'

interface StreamCtx {
  workDir: string | null
  userDataPath: string | null
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
  const out = await runSpec(streamSpec(opts.role, kind), {
    userDataPath: opts.userDataPath,
    bookRoot: opts.bookRoot,
    userPrompt: opts.prompt,
    register: (ctrl) => opts.driver.registerCtrl?.(opts.mainSession, ctrl),
    onReset: () => emit({ type: 'text_reset' }),
    onText: (delta) => emit({ type: 'text', text: delta, role: opts.role }),
  })

  if (out.ok) {
    // B-3：max_tokens 截断 → 警告（落盘保留，但让作者知道原因）
    if (out.data.stopReason === 'max_tokens') {
      emit({ type: 'warning', message: '产出达到长度上限被截断，建议调高单次输出上限' })
    }
    emit({ type: 'done', cost: 0, usage: out.usage?.outputTokens ?? 0, reason: 'success' })
  } else {
    emit({ type: 'error', kind: 'provider', message: out.error, recoverable: false })
  }
}

export function registerStreamRoutes(ctx: StreamCtx): void {
  // SSE 订阅 driver 事件流
  route('GET', '/api/books/:name/stream', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) {
      res.writeHead(400)
      res.end('no workdir')
      return
    }
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) {
      res.writeHead(404)
      res.end('no book')
      return
    }
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
    const iter = driver.stream(session) as AsyncGenerator<DriverEvent>
    // 前端断开 → 中止迭代(释放 mock waiter)
    req.on('close', () => {
      void iter.return(undefined)
    })
    // 客户端断开后写已关闭 socket 会抛错——统一守卫（writableEnded / destroyed）
    const safeWrite = (chunk: string): void => {
      if (!res.writableEnded && !res.destroyed) res.write(chunk)
    }
    try {
      for await (const ev of iter) {
        safeWrite(`data: ${JSON.stringify(ev)}\n\n`)
      }
    } catch (e) {
      safeWrite(
        `data: ${JSON.stringify({
          type: 'error',
          kind: 'stream',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        })}\n\n`,
      )
    }
    if (!res.writableEnded) res.end()
  })

  // 触发写稿：generateText + writerSystem，fire-and-forget + SSE 回流
  route('POST', '/api/books/:name/spawn', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })

    const body = await readJson(req)
    const role = typeof body['role'] === 'string' ? (body['role'] as string) : 'writer'
    const prompt = typeof body['prompt'] === 'string' ? (body['prompt'] as string) : ''
    // P0-3：拒空 prompt——空包只有 system prompt，产出与本书无关；调用方应先拉 /draft-prompt
    if (!prompt.trim()) {
      return reply(res, 400, { error: 'prompt 不能为空（请先拉取 /draft-prompt 组写稿上下文）' })
    }

    const mainSession = await ensureSession(params['name']!, ctx.workDir)
    const driver = getDriver('cc')
    // fire-and-forget：generateText 期间 text 增量经 driver.emit → SSE 回流
    void runWriterSpawn({
      driver,
      mainSession,
      userDataPath: ctx.userDataPath,
      bookRoot: join(ctx.workDir, entry.path),
      prompt,
      role,
    })

    reply(res, 200, { ok: true, role })
  })

  // 中断当前生成：AbortController.abort() + 推 interrupted，session 保留可再 spawn
  route('POST', '/api/books/:name/interrupt', async (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const bookName = params['name']!
    // 先停自愈编排 + 对话编排
    abortSelfHeal(bookName)
    abortChat(bookName)
    const session = await ensureSession(bookName, ctx.workDir)
    const driver = getDriver('cc')
    if (driver.interrupt) driver.interrupt(session)
    reply(res, 200, { ok: true })
  })

  // 全自动写章(红项自愈闭环):AI 写稿 → 机检 → 红则自动退回重写 → 全绿或触顶交作者。
  // fire-and-forget(与 /spawn 同风格):编排最长可跑十几分钟,进度全程经主 session SSE 回流。
  route('POST', '/api/books/:name/auto-write', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const bookName = params['name']!
    // 并发保护:check 阶段无子进程 → isRunning 假空闲 → 前端可再触发,两个编排器会互相覆写草稿
    if (isSelfHealRunning(bookName)) {
      return reply(res, 409, { error: '本书正在全自动写章,先等它跑完或中断' })
    }

    const body = await readJson(req)
    const chapter = Number(body['chapter'])
    if (!Number.isInteger(chapter) || chapter < 1) {
      return reply(res, 400, { error: 'chapter 需为正整数' })
    }

    // session.cwd = workDir(角色 agents 在 workDir/.claude/agents)
    const mainSession = await ensureSession(bookName, ctx.workDir)
    const driver = getDriver('cc')
    void runSelfHeal({
      driver,
      mainSession,
      userDataPath: ctx.userDataPath!,
      cwd: ctx.workDir,
      bookRoot: join(ctx.workDir, entry.path),
      bookName,
      chapter,
    })

    reply(res, 200, { ok: true, chapter })
  })

  // 对话助手：fire-and-forget + SSE 回流（与 /spawn 同模式）
  route('POST', '/api/books/:name/chat', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const bookName = params['name']!
    if (isChatRunning(bookName)) {
      return reply(res, 409, { error: '本书正在对话中，请等当前对话结束' })
    }

    const body = await readJson(req)
    const message = String(body['message'] ?? '').trim()
    if (!message) return reply(res, 400, { error: 'message 必填' })
    const chapter = body['chapter'] !== undefined ? Number(body['chapter']) : undefined

    const mainSession = await ensureSession(bookName, ctx.workDir)
    const driver = getDriver('cc')
    void runChat({
      driver,
      mainSession,
      userDataPath: ctx.userDataPath!,
      bookRoot: join(ctx.workDir, entry.path),
      bookName,
      message,
      ...(chapter !== undefined ? { chapter } : {}),
    })

    reply(res, 200, { ok: true })
  })

  // 工具确认：作者点了确认/取消
  route('POST', '/api/books/:name/chat/confirm', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const bookName = params['name']!
    const body = await readJson(req)
    const callId = String(body['callId'] ?? '')
    const ok = Boolean(body['ok'])
    if (!callId) return reply(res, 400, { error: 'callId 必填' })

    const found = resolveChatConfirm(bookName, callId, ok)
    if (!found) return reply(res, 404, { error: '未找到待确认的工具调用（已超时或已取消）' })
    reply(res, 200, { ok: true })
  })
}
