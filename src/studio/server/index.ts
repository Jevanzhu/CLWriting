/**
 * studio 后端 server（Node 原生 http，#12.1 / #12.2）。
 *
 * 单进程 server：/api/* 走 REST 分发器，其余路径静态托管前端 dist。
 * 只监听 127.0.0.1（本地 GUI，不对外）。driver 会话、SSE 等在后续
 * Step 引入。
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRouteTable, dispatch, withRouteTable, type RouteTable } from './router.js'
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
import { registerPiecesRoutes } from './api/pieces.js'
import { registerStateRoutes } from './api/state.js'
import { registerIoRoutes } from './api/io.js'
import { registerKnowledgeRoutes } from './api/knowledge.js'
import { registerHeartbeatRoutes } from './api/heartbeat.js'
import { createStaticHandler } from './static.js'

/** 注册 REST 路由到独立路由表，避免多 server 复用旧 workDir/token 闭包。 */
function buildRoutes(workDir: string | null, token: string): RouteTable {
  const routes = createRouteTable()
  withRouteTable(routes, () => {
    registerBookRoutes({ workDir, token })
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
    registerPiecesRoutes({ workDir })
    registerStateRoutes({ workDir })
    registerIoRoutes({ workDir, token })
    registerKnowledgeRoutes({ workDir, token })
    registerHeartbeatRoutes({ workDir })
  })
  return routes
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
  const studioToken = randomUUID()
  const routes = buildRoutes(opts.workDir ?? null, studioToken)
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
      res.setHeader('access-control-allow-headers', 'content-type, x-studio-token')
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
    // 写端点 session token 校验(P0 defense-in-depth):防跨站伪造,无/错 token → 403
    if (isWrite && req.headers['x-studio-token'] !== studioToken) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'invalid or missing studio token' }))
      return
    }

    // API 优先
    if (req.url?.startsWith('/api/')) {
      const matched = await dispatch(req, res, routes)
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

  // 固定端口同步入白名单(避免 listen→listening 间毫秒级窗口校验失败);port 0 仍靠 listening 回调补实际端口
  if (opts.port > 0) {
    allowedOrigins.add(`http://127.0.0.1:${opts.port}`)
    allowedOrigins.add(`http://localhost:${opts.port}`)
  }
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
