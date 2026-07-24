/**
 * driver SSE 端点(批1 mock):GUI 订阅 driver 事件流 + 触发生成。
 *
 * GET  /api/books/:name/stream → SSE(订阅 driver.stream,持续推送 DriverEvent)
 * POST /api/books/:name/spawn  → 触发 spawnRole / send(body {role, prompt, mode?})
 *
 * 架构红线:此处只转发 driver 事件 / 触发 driver,不直连大模型。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { ensureSession, getDriver, type DriverEvent } from '../../../driver/index.js'

interface StreamCtx {
  workDir: string | null
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
      `data: ${JSON.stringify({ type: 'sync', running: driver.isRunning?.(session) ?? false })}\n\n`,
    )

    // driver.stream 实现为 async generator(mock async * / 批2 cc 解析 stream-json)
    const iter = driver.stream(session) as AsyncGenerator<DriverEvent>
    // 前端断开 → 中止迭代(释放 mock waiter)
    req.on('close', () => {
      void iter.return(undefined)
    })
    try {
      for await (const ev of iter) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`)
      }
    } catch (e) {
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          kind: 'stream',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        })}\n\n`,
      )
    }
    res.end()
  })

  // 触发生成
  route('POST', '/api/books/:name/spawn', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })

    const body = await readJson(req)
    const role = typeof body['role'] === 'string' ? (body['role'] as string) : 'writer'
    const prompt = typeof body['prompt'] === 'string' ? (body['prompt'] as string) : ''
    const mode = body['mode'] === 'send' ? 'send' : 'spawnRole'

    // session.cwd = workDir(角色 agents 在 workDir/.claude/agents,init generateRoleShells 生成处)
    const session = await ensureSession(params['name']!, ctx.workDir)
    const driver = getDriver('cc')
    if (mode === 'send') driver.send(session, prompt)
    else driver.spawnRole(session, role, prompt)

    reply(res, 200, { ok: true, mode, role })
  })

  // 中断当前生成(6.8③):kill 子进程 + 推 interrupted,session 保留可再 spawn
  route('POST', '/api/books/:name/interrupt', async (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const session = await ensureSession(params['name']!, ctx.workDir)
    const driver = getDriver('cc')
    if (driver.interrupt) driver.interrupt(session)
    reply(res, 200, { ok: true })
  })
}
