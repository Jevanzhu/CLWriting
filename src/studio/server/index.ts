/**
 * studio 后端 server（Node 原生 http，#12.1 / #12.2）。
 *
 * 单进程 server：/api/* 走 REST 分发器，其余路径静态托管前端 dist。
 * 只监听 127.0.0.1（本地 GUI，不对外）。driver 会话、SSE 等在后续
 * Step 引入。
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRouteTable, dispatch, withRouteTable, type RouteTable } from './router.js'
import { readBooks } from '../../install/books.js'
import { migratePieceLayout } from '../../format/pieces.js'
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
import { registerReviewRoutes } from './api/review.js'
import { registerOnboardRoutes } from './api/onboard.js'
import { registerRewriteRoutes } from './api/rewrite.js'
import { registerConfigRoutes } from './api/config.js'
import { registerPrefsRoutes } from './api/prefs.js'
import { registerPiecesRoutes } from './api/pieces.js'
import { registerStateRoutes } from './api/state.js'
import { registerIoRoutes } from './api/io.js'
import { registerKnowledgeRoutes } from './api/knowledge.js'
import { registerHeartbeatRoutes } from './api/heartbeat.js'
import { registerDocumentRoutes } from './api/documents.js'
import { registerSnapshotRoutes } from './api/snapshots.js'
import { registerSearchRoutes } from './api/search.js'
import { registerCheckRoutes } from './api/check.js'
import { registerAnalysisRoutes } from './api/analysis.js'
import { registerForeshadowRoutes } from './api/foreshadows.js'
import { registerStyleRoutes } from './api/style.js'
import { registerAiStatusRoutes } from './api/ai-status.js'
import { registerProvidersRoutes } from './api/providers.js'
import { createStaticHandler } from './static.js'
import { initCcDriver } from '../../driver/index.js'

/** 注册 REST 路由到独立路由表，避免多 server 复用旧 workDir/token 闭包。 */
function buildRoutes(workDir: string | null, token: string, userDataPath: string | null): RouteTable {
  const routes = createRouteTable()
  withRouteTable(routes, () => {
    // 元：AI 可达性探测（editor/ai 共用，G4 降级体验）
    registerAiStatusRoutes({ userDataPath })

    // ── editor 组（无 driver 依赖；AI 不可达时照常工作）──
    registerBookRoutes({ workDir, token })
    registerHealthRoutes({ workDir })
    registerFileRoutes({ workDir })
    registerOverviewRoutes({ workDir })
    registerRhythmRoutes({ workDir })
    registerLeadsRoutes({ workDir })
    registerSettingsRoutes({ workDir })
    registerDraftRoutes({ workDir })
    registerConfigRoutes({ workDir })
    registerPrefsRoutes({ workDir, userDataPath })
    registerPiecesRoutes({ workDir })
    registerStateRoutes({ workDir })
    registerIoRoutes({ workDir, token })
    registerKnowledgeRoutes({ workDir, token })
    registerHeartbeatRoutes({ workDir })
    registerDocumentRoutes({ workDir })
    registerSnapshotRoutes({ workDir })
    registerSearchRoutes({ workDir })
    registerCheckRoutes({ workDir })
    registerAnalysisRoutes({ workDir, userDataPath })
    registerForeshadowRoutes({ workDir })
    registerStyleRoutes({ workDir })
    registerProvidersRoutes({ userDataPath })

    // ── ai 组（依赖 driver；AI 不可达时前端置灰）──
    registerStreamRoutes({ workDir, userDataPath })
    registerOutlineRoutes({ workDir })
    registerReviewRoutes({ workDir, userDataPath })
    registerOnboardRoutes({ workDir })
    registerRewriteRoutes({ workDir, userDataPath })
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
  /** APP 级数据目录（Electron userData / CLI 约定路径）；全局偏好 JSON 存储位置 */
  userDataPath?: string | null
}

/** 起 server 并监听（返回 http.Server，由调用方管 listening / error / 关闭） */
export function startServer(opts: StudioServerOptions): http.Server {
  const studioToken = randomUUID()
  // 迁移旧短篇目录结构（篇/N-T/正文.md → 篇/N-T.md + 清单/N-T.md；幂等，无旧结构 no-op）
  if (opts.workDir) {
    for (const book of readBooks(opts.workDir)) {
      migratePieceLayout(join(opts.workDir, book.path))
    }
  }
  // 注入 userDataPath 到 cc driver（读 providers.json 取当前供应商）
  initCcDriver(opts.userDataPath ?? null)
  const routes = buildRoutes(opts.workDir ?? null, studioToken, opts.userDataPath ?? null)
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
  // keep-alive 治理:Node 默认 keepAliveTimeout=5s,客户端连接池缓存的连接超过 5s 被服务端关掉,
  // 客户端复用已 FIN 的 socket 写入 → EPIPE(长生成后 POST 大草稿体时偶发)。
  // 拉长到 30s 覆盖 AI 生成间隔;headersTimeout 必须 > keepAliveTimeout(Node v19+ 硬约束)。
  server.keepAliveTimeout = 30_000
  server.headersTimeout = 35_000
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
