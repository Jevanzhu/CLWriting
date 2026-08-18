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
import { safeTokenCompare } from './http.js'
import { readBooks, repairBooks } from '../../install/books.js'
import { migrateLayoutV2 } from '../../install/migrate-layout-v2.js'
import { migrateLayoutV3 } from '../../install/migrate-layout-v3.js'
import { migrateFinalizedRevisions } from '../../install/migrate-finalized-revision.js'
import { migrateBookDefaults } from '../../install/migrate-defaults.js'
import { migrateLegacyForeshadows } from '../../document/foreshadow.js'
import { migrateVersionsDir } from '../../document/snapshot.js'
import { registerBookRoutes } from './api/books.js'
import { registerRagRoutes } from './api/rag.js'
import { registerRagProviderRoutes } from './api/rag-providers.js'
import { registerHealthRoutes } from './api/health.js'
import { registerFileRoutes } from './api/files.js'
import { registerOverviewRoutes } from './api/overview.js'
import { registerRhythmRoutes } from './api/rhythm.js'
import { registerSettingsRoutes } from './api/settings.js'
import { registerStreamRoutes } from './api/stream.js'
import { registerDraftRoutes } from './api/draft.js'
import { registerOutlineRoutes } from './api/outline.js'
import { registerReviewRoutes } from './api/review.js'
import { registerOnboardRoutes } from './api/onboard.js'
import { registerRewriteRoutes } from './api/rewrite.js'
import { registerConfigRoutes } from './api/config.js'
import { registerPrefsRoutes } from './api/prefs.js'
import { registerStateRoutes } from './api/state.js'
import { registerIoRoutes } from './api/io.js'
import { registerKnowledgeRoutes } from './api/knowledge.js'
import { registerHeartbeatRoutes } from './api/heartbeat.js'
import { registerDocumentRoutes } from './api/documents.js'
import { registerSnapshotRoutes } from './api/snapshots.js'
import { registerSearchRoutes } from './api/search.js'
// C2：内置 prompt overlay 升级迁移（startServer 启动期执行一次）
import { migratePromptOverlays } from '../../ai/prompts/resource.js'
import { registerCheckRoutes } from './api/check.js'
import { registerAnalysisRoutes } from './api/analysis.js'
import { registerForeshadowRoutes } from './api/foreshadows.js'
import { registerStyleRoutes } from './api/style.js'
import { registerAiStatusRoutes } from './api/ai-status.js'
import { registerProvidersRoutes } from './api/providers.js'
import { registerTraceStatsRoutes } from './api/trace-stats.js'
import { registerAuditRoutes } from './api/audit.js'
import { registerChatHistoryRoutes } from './api/chat-history.js'
import { registerChatBranchesRoutes } from './api/chat-branches.js'
import { registerLeadUpdateRoutes } from './api/lead-updates.js'
import { resetRouteSchemas } from './api/schema.js'
import { createStaticHandler } from './static.js'

/** 注册 REST 路由到独立路由表，避免多 server 复用旧 workDir/token 闭包。 */
function buildRoutes(
  workDir: string | null,
  token: string,
  userDataPath: string | null,
  isTrustedOrigin: (origin: string) => boolean,
): RouteTable {
  const routes = createRouteTable()
  // E2：schema 注册表随路由表生命周期重置（防跨 server 实例重复声明）
  resetRouteSchemas()
  withRouteTable(routes, () => {
    // 元：AI 可达性探测（editor/ai 共用，G4 降级体验）
    registerAiStatusRoutes({ userDataPath })

    // ── editor 组（无 driver 依赖；AI 不可达时照常工作）──
    registerBookRoutes({ workDir, token, isTrustedOrigin, userDataPath })
    // cc 批4（P1-8）：RAG 建索引/状态端点——buildIndex 生产入口；
    // 服务商化：书级引用 + 应用级 RAG 服务商（providers.json ragProviders 段）
    registerRagRoutes({ workDir, userDataPath })
    registerRagProviderRoutes({ userDataPath })
    registerHealthRoutes({ workDir })
    registerFileRoutes({ workDir })
    registerOverviewRoutes({ workDir, userDataPath }) // 全局托底：genre/target_words/volume_size 喂运行时合并 global.json
    registerRhythmRoutes({ workDir })
    registerSettingsRoutes({ workDir, userDataPath })
    registerDraftRoutes({ workDir, userDataPath })
    registerConfigRoutes({ workDir })
    registerPrefsRoutes({ workDir, userDataPath })
    registerStateRoutes({ workDir })
    registerIoRoutes({ workDir, token })
    registerKnowledgeRoutes({ workDir, token })
    registerHeartbeatRoutes({ workDir })
    registerDocumentRoutes({ workDir, userDataPath }) // Z-P2-6：伏笔事件族接线（伏笔文档变更落 foreshadow/change）
    registerSnapshotRoutes({ workDir, userDataPath }) // 版本保留三层链：global.json 全局默认（book.yaml 未设时生效）
    registerSearchRoutes({ workDir })
    registerCheckRoutes({ workDir, userDataPath }) // 全局托底：机检 short.strict 吃生效值
    registerAnalysisRoutes({ workDir, userDataPath })
    registerForeshadowRoutes({ workDir })
    registerStyleRoutes({ workDir, userDataPath }) // 全局托底：注入强度喂写作链路合并 global.json
    registerProvidersRoutes({ userDataPath })
    registerTraceStatsRoutes({ workDir, userDataPath })
    registerAuditRoutes({ workDir, userDataPath })
    registerChatHistoryRoutes({ workDir, userDataPath }) // Y-P2-5：对话历史只读端点（editor 组，同 audit 事件读取模式）
    registerChatBranchesRoutes({ workDir, userDataPath }) // G1：分支列表只读端点（editor 组，分支 UI 服务端支撑）

    // ── ai 组（依赖 driver；AI 不可达时前端置灰）──
    registerStreamRoutes({ workDir, userDataPath, studioToken: token })
    registerOutlineRoutes({ workDir, userDataPath })
    registerLeadUpdateRoutes({ workDir, userDataPath })
    registerReviewRoutes({ workDir, userDataPath })
    registerOnboardRoutes({ workDir, userDataPath })
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
  // C2：内置 prompt overlay 升级迁移（幂等——未改动的旧版拷贝升级为当前内置，
  // 用户改过的原样保留；A6「升级不覆盖用户改动」的落点）
  if (opts.userDataPath) {
    try {
      const r = migratePromptOverlays(opts.userDataPath)
      if (r.upgraded.length > 0) console.error(`[migrate-prompts] 已升级未改动副本：${r.upgraded.join(', ')}`)
    } catch (e) {
      console.error(`[migrate-prompts] ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // 书库自愈（P1-10）：books.jsonl 损坏/移书后启动即扫描重建登记——幂等，完好时
  // changed=false 不写盘；变更时报告供诊断（作者侧零交互）。置于迁移循环前：
  // 先保证登记完整，逐书迁移才遍历得到全部书。
  if (opts.workDir) {
    try {
      const r = repairBooks(opts.workDir)
      if (r.changed) {
        console.error(
          `[repair-books] 书库登记已自愈：登记 ${r.rebuilt.length} 条、缺失 ${r.missing.length} 条、重关联 ${r.relinked.length} 条`,
        )
      }
    } catch (e) {
      console.error(`[repair-books] ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // 版本档案目录迁移：工作区/.snapshots → 工作区/.版本（幂等，旧目录不存在 no-op）
  if (opts.workDir) {
    for (const book of readBooks(opts.workDir)) {
      const bookPath = join(opts.workDir, book.path)
      const v2Result = migrateLayoutV2(bookPath)
      if (v2Result.errors.length > 0) {
        console.error(`[migrate-layout-v2] ${book.path}: ${v2Result.errors.length} 个错误\n${v2Result.errors.join('\n')}`)
      }
      const v3Result = migrateLayoutV3(bookPath)
      if (v3Result.errors.length > 0) {
        console.error(`[migrate-layout-v3] ${book.path}: ${v3Result.errors.length} 个错误\n${v3Result.errors.join('\n')}`)
      }
      // 版本档案目录迁移：工作区/.snapshots → 工作区/.版本（幂等，旧目录不存在 no-op）
      migrateVersionsDir(bookPath)
      // 定稿基线迁移：旧 git 书库 clean→final / dirty→revision / untracked→draft（幂等）
      migrateFinalizedRevisions(bookPath)
      // 伏笔迁移：大纲/伏笔/ → 设定/伏笔/（幂等，旧目录不存在 no-op）
      migrateLegacyForeshadows(bookPath)
    }
  }
  // 书级默认值一次性迁移（全局托底配套）：旧 scaffold 把 13 键默认值烘焙进了 book.yaml，
  // 不删掉的话书级「永远已设」、全局托底被遮蔽。文本级补丁（保注释保未知段）、逐书容错、
  // 幂等——启动即跑，listen 前（workDir 就绪后）。详情见 migrate-defaults.ts。
  if (opts.workDir) {
    try {
      migrateBookDefaults(opts.workDir)
    } catch (e) {
      // 整体异常不阻断启动（逐书失败已在内部 warn 过；这里兜编译期不可见的故障）
      console.error(`[migrate-defaults] ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // RB-SV-P1-1：Origin 白名单只含实际监听 origin（下方 listening 补，同源放行）；
  // dev Vite(5173) 仅 CLW_DEV_UI/CLW_DEV_CORS 显式开启时注入（scripts/dev-api.ts 设 env，
  // dev:web/dev:app 链路保持可用）——生产态不再放行本地任意监听 5173 的页面。
  const allowedOrigins = new Set<string>()
  if (process.env['CLW_DEV_UI'] === '1' || process.env['CLW_DEV_CORS'] === '1') {
    allowedOrigins.add('http://127.0.0.1:5173')
    allowedOrigins.add('http://localhost:5173')
  }
  const isTrustedOrigin = (origin: string): boolean => allowedOrigins.has(origin)
  const routes = buildRoutes(opts.workDir ?? null, studioToken, opts.userDataPath ?? null, isTrustedOrigin)
  // CC-P2-13：host 选项此前是陷阱——允许传任意监听地址，但下方 Host 白名单硬编码回环，
  // 传非回环 host 时全请求 403（参数存在即故障）。产品口径仅本机回环（本文件头注释），
  // 非回环值启动即拒——fail-fast 优于逐请求 403 的静默失效。
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
  const host = opts.host ?? '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`不支持的非回环监听地址：${host}——Studio 服务仅限本机回环（127.0.0.1 / localhost / ::1）`)
  }
  const serveStatic = opts.staticDir ? createStaticHandler(opts.staticDir) : null

  const isAllowedOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin
    // 无 Origin(同源 GET 请求 / curl / 非浏览器)放行;浏览器带 Origin 则校验白名单
    return !origin || allowedOrigins.has(origin)
  }

  // 实际监听端口（listening 后缓存，供 Host 白名单校验；0 = 未监听）
  let listeningPort = 0
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // DNS rebinding 防御（U-P2-6）：Host 头必须精确匹配本机回环地址 + 实际监听端口。
    // GET 端点无 Origin 头可校验——攻击页把域名二次解析到 127.0.0.1 后，同源 GET
    // 即可全量读取书稿/配置；Host 校验切断该路径（写路径已有 Origin+token 双闸）
    {
      const host = req.headers.host
      if (listeningPort === 0 || (host !== `127.0.0.1:${listeningPort}` && host !== `localhost:${listeningPort}` && host !== `[::1]:${listeningPort}`)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'forbidden host' }))
        return
      }
    }
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
    // 写端点(POST/PUT/DELETE/PATCH)Origin 校验:非白名单 → 403(防跨站写,即使 CORS 不阻简单请求)
    const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' || req.method === 'PATCH'
    if (isWrite && !isAllowedOrigin(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'forbidden origin' }))
      return
    }
    // 写端点 session token 校验(P0 defense-in-depth):防跨站伪造,无/错 token → 403
    if (isWrite && !safeTokenCompare(req.headers['x-studio-token'], studioToken)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'invalid or missing studio token' }))
      return
    }

    // API 优先
    if (req.url?.startsWith('/api/')) {
      try {
        const matched = await dispatch(req, res, routes)
        if (matched || res.headersSent) return
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      } catch (e) {
        if (!res.headersSent) {
          // P3-9：不向客户端泄漏 detail（含文件路径等），仅 console.error 留诊断
          console.error('[api] unhandled error:', e)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '服务器内部错误' }))
        }
        return
      }
    }

    // 静态托管前端
    if (serveStatic) return serveStatic(req, res)
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

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
      listeningPort = addr.port
    }
  })
  return server
}
