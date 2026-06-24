/**
 * GUI 活跃心跳端点（#1.5 单写者协作）。
 *
 * POST   /api/books/:name/heartbeat → writeGuiActive（续期）→ { ok }
 * DELETE /api/books/:name/heartbeat → clearGuiActive（切书/离开）→ { ok }
 *
 * 前端 BookTabs mounted + setInterval 调 POST；unmount 调 DELETE。
 * CLI 写命令（finalize/check/confirm）检测 .gui-active 新鲜则轻提示，不阻塞。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'
import { writeGuiActive, clearGuiActive } from '../../../process/gui-active.js'

interface HeartbeatCtx {
  workDir: string | null
}

export function registerHeartbeatRoutes(ctx: HeartbeatCtx): void {
  route('POST', '/api/books/:name/heartbeat', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书：${params['name']}` })
    writeGuiActive(join(ctx.workDir, entry.path))
    reply(res, 200, { ok: true })
  })

  route('DELETE', '/api/books/:name/heartbeat', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书：${params['name']}` })
    clearGuiActive(join(ctx.workDir, entry.path))
    reply(res, 200, { ok: true })
  })
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
