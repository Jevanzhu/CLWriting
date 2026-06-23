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
import { registerCliRoutes } from './api/cli.js'
import { registerReviewRoutes } from './api/review.js'
import { registerOnboardRoutes } from './api/onboard.js'
import { registerRewriteRoutes } from './api/rewrite.js'
import { registerConfigRoutes } from './api/config.js'
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
  registerCliRoutes({ workDir })
  registerReviewRoutes({ workDir })
  registerOnboardRoutes({ workDir })
  registerRewriteRoutes({ workDir })
  registerConfigRoutes({ workDir })
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

  // Origin 白名单(防 localhost 跨站调用,P0):dev Vite(5173)固定 + 实际 listening 端口(下方补)
  const allowedOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173'])
  const isAllowedOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin
    // 无 Origin(同源请求 / curl / 非浏览器)放行;浏览器带 Origin 则校验白名单
    return !origin || allowedOrigins.has(origin)
  }

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin
    // CORS:只对白名单 Origin 设 ACAO(跨站浏览器读被阻)
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS')
      res.setHeader('access-control-allow-headers', 'content-type')
      res.setHeader('vary', 'origin')
    }
    // 预检 OPTIONS:非白名单 Origin → 403(阻跨站实际请求)
    if (req.method === 'OPTIONS') {
      if (origin && !allowedOrigins.has(origin)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'forbidden origin' }))
        return
      }
      res.writeHead(204)
      res.end()
      return
    }
    // 写端点(POST/PUT/DELETE)Origin 校验:非白名单 → 403(防跨站写,即使 CORS 不阻简单请求)
    const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE'
    if (isWrite && !isAllowedOrigin(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'forbidden origin' }))
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
  // listening 后补实际端口(port 0 随机端口)
  server.on('listening', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      allowedOrigins.add(`http://127.0.0.1:${addr.port}`)
      allowedOrigins.add(`http://localhost:${addr.port}`)
    }
  })
  return server
}
