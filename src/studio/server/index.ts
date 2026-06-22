/**
 * studio 后端 server（Node 原生 http，#12.1 / #12.2）。
 *
 * 单进程 server：/api/* 走 REST 分发器，其余路径静态托管前端 dist。
 * 只监听 127.0.0.1（本地 GUI，不对外）。driver 会话、SSE 等在后续
 * Step 引入。
 */
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dispatch } from './router.js'
import { registerBookRoutes } from './api/books.js'
import { registerHealthRoutes } from './api/health.js'
import { registerFileRoutes } from './api/files.js'
import { registerOverviewRoutes } from './api/overview.js'
import { registerRhythmRoutes } from './api/rhythm.js'
import { registerLeadsRoutes } from './api/leads.js'
import { registerSettingsRoutes } from './api/settings.js'
import { registerStreamRoutes } from './api/stream.js'
import { registerDraftRoutes } from './api/draft.js'
import { registerOutlineRoutes } from './api/outline.js'
import { createStaticHandler } from './static.js'

let routesRegistered = false

/** 注册 REST 路由（幂等，避免多入口重复注册） */
function ensureRoutes(workDir: string | null): void {
  if (routesRegistered) return
  registerBookRoutes({ workDir })
  registerHealthRoutes({ workDir })
  registerFileRoutes({ workDir })
  registerOverviewRoutes({ workDir })
  registerRhythmRoutes({ workDir })
  registerLeadsRoutes({ workDir })
  registerSettingsRoutes({ workDir })
  registerStreamRoutes({ workDir })
  registerDraftRoutes({ workDir })
  registerOutlineRoutes({ workDir })
  routesRegistered = true
}

export interface StudioServerOptions {
  port: number
  host?: string
  /** 前端构建产物目录；缺省则不托管静态（仅 API） */
  staticDir?: string
  /** CLWriting 工作目录（含 .clwriting/）；null/缺省 = 未定位，书架将为空 + 提示 */
  workDir?: string | null
}

/** 起 server 并监听（返回 http.Server，由调用方管 listening / error / 关闭） */
export function startServer(opts: StudioServerOptions): http.Server {
  ensureRoutes(opts.workDir ?? null)
  const host = opts.host ?? '127.0.0.1'
  const serveStatic = opts.staticDir ? createStaticHandler(opts.staticDir) : null

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 本地用，CORS 宽松（dev 时 Vite 5173 → 后端 7878 跨端口）
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // API 优先
    if (req.url?.startsWith('/api/')) {
      const matched = await dispatch(req, res)
      if (matched || res.headersSent) return
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    // 静态托管前端
    if (serveStatic) return serveStatic(req, res)
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  server.listen(opts.port, host)
  return server
}
