/**
 * GUI 活跃心跳端点（#1.5 单写者协作）。
 *
 * POST   /api/books/:name/heartbeat → writeGuiActive（续期）→ { ok }
 * DELETE /api/books/:name/heartbeat → clearGuiActive（切书/离开）→ { ok }
 *
 * 前端 useHeartbeat mounted + setInterval 调 POST；unmount 调 DELETE。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { writeGuiActive, clearGuiActive } from '../../../process/gui-active.js'

interface HeartbeatCtx {
  workDir: string | null
}

export function registerHeartbeatRoutes(ctx: HeartbeatCtx): void {
  defineRoute('books.heartbeat.post', {
    method: 'POST',
    path: '/api/books/:name/heartbeat',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    writeGuiActive(r.bookRoot)
    reply(res, 200, { ok: true })
  },
  })

  defineRoute('books.heartbeat.delete', {
    method: 'DELETE',
    path: '/api/books/:name/heartbeat',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    clearGuiActive(r.bookRoot)
    reply(res, 200, { ok: true })
  },
  })
}
