/**
 * studio 后端 server（Node 原生 http，#12.1 / #12.2）。
 *
 * 单进程 server：/api/* 走 REST 分发器，其余路径静态托管前端 dist。
 * 只监听 127.0.0.1（本地 GUI，不对外）。driver 会话、SSE 流已在此
 * 进程内实装（chat/rewrite 等长连接经 SSE 下发；driver 由本进程起子进程/CmHost 桥接）。
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRouteTable, dispatch, withRouteTable, type RouteTable } from './router.js'
import { safeTokenCompare, replyError, urlPathOnly } from './http.js'
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
import { createStreamTicketStore, registerStreamTicketRoutes, type StreamTicketStore } from './api/stream-ticket.js'
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
import { registerCostStatsRoutes } from './api/cost-stats.js' // D2（批 5）：llm/call × 价格表聚合
import { registerAuditRoutes } from './api/audit.js'
import { registerChatHistoryRoutes } from './api/chat-history.js'
import { registerChatBranchesRoutes } from './api/chat-branches.js'
import { registerLeadUpdateRoutes } from './api/lead-updates.js'
// T2-4：task-gate 跨进程文件锁根目录注入（书库 .clwriting/task-gate/；无 workDir → 纯内存闸）
import { configureTaskGateLockRoot } from './api/task-gate.js'
import { resetRouteSchemas } from './api/schema.js'
import { setInitialBook } from './api/books.js'
// A4（批 0）：启动通告端点——启动链迁移失败对用户可见（App 级横幅数据源）
import { createStartupNoticeSink, registerStartupNoticeRoutes, type StartupNoticeSink } from './api/startup-notices.js'
import { createStaticHandler } from './static.js'
import { initLogging, log } from '../../log/index.js'

/** 注册 REST 路由到独立路由表，避免多 server 复用旧 workDir/token 闭包。 */
function buildRoutes(
  workDir: string | null,
  token: string,
  userDataPath: string | null,
  isTrustedOrigin: (origin: string) => boolean,
  sink: StartupNoticeSink,
  streamTickets: StreamTicketStore,
): RouteTable {
  const routes = createRouteTable()
  // E2：schema 注册表随路由表生命周期重置（防跨 server 实例重复声明）
  resetRouteSchemas()
  withRouteTable(routes, () => {
    // 元：AI 可达性探测（editor/ai 共用，G4 降级体验）
    registerAiStatusRoutes({ userDataPath })
    // 元：启动通告（A4 批 0）——启动链迁移失败 / 事件库迁移失败的用户可见出口
    registerStartupNoticeRoutes({ sink })

    // ── editor 组（无 driver 依赖；AI 不可达时照常工作）──
    registerBookRoutes({ workDir, token, isTrustedOrigin, userDataPath, onStartupNotice: sink.add })
    // cc 批4（P1-8）：RAG 建索引/状态端点——buildIndex 生产入口；
    // 服务商化：书级引用 + 应用级 RAG 服务商（providers.json ragProviders 段）
    registerRagRoutes({ workDir, userDataPath })
    registerRagProviderRoutes({ userDataPath })
    registerHealthRoutes({ workDir })
    registerFileRoutes({ workDir, userDataPath }) // R26-9（二十六轮）：PUT /file 覆盖留底读全局保留策略
    registerOverviewRoutes({ workDir, userDataPath }) // 全局托底：genre/target_words/volume_size 喂运行时合并 global.json
    registerRhythmRoutes({ workDir })
    registerSettingsRoutes({ workDir, userDataPath })
    registerDraftRoutes({ workDir, userDataPath })
    registerConfigRoutes({ workDir })
    registerPrefsRoutes({ workDir, userDataPath })
    registerStateRoutes({ workDir, userDataPath }) // GG-P2-5：状态机入口过全局托底链（volume_size 等喂生效值）
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
    registerCostStatsRoutes({ workDir, userDataPath })
    registerAuditRoutes({ workDir, userDataPath })
    registerChatHistoryRoutes({ workDir, userDataPath }) // Y-P2-5：对话历史只读端点（editor 组，同 audit 事件读取模式）
    registerChatBranchesRoutes({ workDir, userDataPath }) // G1：分支列表只读端点（editor 组，分支 UI 服务端支撑）

    // ── ai 组（依赖 driver；AI 不可达时前端置灰）──
    // R73-49（二十一轮）：ticket 库随本实例建，签发与 SSE 消费两侧共享同一份——
    // 票不跨 server 实例残留/消费（对齐路由表 per-server 生命周期）
    registerStreamRoutes({ workDir, userDataPath, studioToken: token, tickets: streamTickets })
    registerStreamTicketRoutes(streamTickets) // T2 批：SSE 一次性 ticket 签发（POST 走写闸），token 不再出 URL
    registerOutlineRoutes({ workDir, userDataPath })
    registerLeadUpdateRoutes({ workDir, userDataPath })
    registerReviewRoutes({ workDir, userDataPath })
    registerOnboardRoutes({ workDir, userDataPath })
    registerRewriteRoutes({ workDir, userDataPath })
  })
  return routes
}

/**
 * X-19（第五十六轮）：GET token 闸豁免清单——显式路径表（精确模式匹配）。
 * 原实现用 `path.endsWith('/stream')` 后缀匹配：任何尾段恰为 /stream 的端点（包括
 * 将来新增的路由命名撞车）都会静默失闸。豁免面收敛为两条精确模式：
 * - /api/boot：前端无 token 时的 bootstrap 通道，token 本身由它下发；
 * - /api/books/:name/stream：SSE 端点（EventSource 不能带头），经此处放行后由
 *   stream.ts 自带的一次性 ticket / query token 双凭据闸校验；:name 为单路径段
 *   （[^/]+），与 router.ts :param 捕获口径一致。
 * 健康检查无独立顶层端点（health.ts 为书级业务端点，不豁免）；非 /api/ 静态资源不受影响。
 */
const GET_TOKEN_EXEMPT_PATHS: readonly RegExp[] = [/^\/api\/boot$/, /^\/api\/books\/[^/]+\/stream$/]

export interface StudioServerOptions {
  port: number
  host?: string
  /** 前端构建产物目录；缺省则不托管静态（仅 API） */
  staticDir?: string
  /** CLWriting 工作目录（含 .clwriting/）；null/缺省 = 未定位，书架将为空 + 提示 */
  workDir?: string | null
  /** APP 级数据目录（Electron userData / CLI 约定路径）；全局偏好 JSON 存储位置 */
  userDataPath?: string | null
  /** 日志是否镜像 console（A4 批 0）——dev/CLI 态 true（看得见）；Electron 打包态
   *  console 输出到无人看见的地方，传 false 只落 JSONL。缺省 true。 */
  mirrorConsoleLog?: boolean
  /** studio 会话 token（U-6 A，阶段 22 唯一红线豁免）：缺省 randomUUID() 行为不变；
   *  Electron 拆分形态由 main 侧 server-manager 持久化注入（跨崩溃重启稳定——前端
   *  token 仅挂载时取一次，换代即写/SSE/心跳永久 403）。协议语义零改动。 */
  studioToken?: string
}

/** 起 server 并监听（返回 http.Server，由调用方管 listening / error / 关闭） */
export function startServer(opts: StudioServerOptions): http.Server {
  const studioToken = opts.studioToken ?? randomUUID()
  // A4（批 0）：结构化日志——JSONL 按天落 userData/logs/，未提供 userDataPath 时
  // 保持纯 console 镜像（与引入前行为一致）。desktop main 可能已提前 init（幂等）。
  initLogging({
    logsDir: opts.userDataPath ? join(opts.userDataPath, 'logs') : null,
    mirrorConsole: opts.mirrorConsoleLog ?? true,
  })
  // A4（批 0）：启动链通告收集——迁移失败不再是「console 失明出口」，统一进
  // startupNotices 供 /api/startup-notices + App 横幅消费
  const sink = createStartupNoticeSink()
  const noticeOrLog = (kind: string, message: string, err?: unknown): void => {
    sink.add(kind, message)
    log.error(kind, message, err)
  }
  // C2：内置 prompt overlay 升级迁移（幂等——未改动的旧版拷贝升级为当前内置，
  // 用户改过的原样保留；A6「升级不覆盖用户改动」的落点）
  if (opts.userDataPath) {
    try {
      const r = migratePromptOverlays(opts.userDataPath)
      // 信息性留痕（非故障，不进横幅）：作者可见性无诉求，日志留诊断即可
      if (r.upgraded.length > 0) {
        log.warn('migrate-prompts', `已升级未改动 prompt 副本：${r.upgraded.join(', ')}`)
      }
    } catch (e) {
      noticeOrLog('migrate-prompts', `prompt overlay 迁移失败：${e instanceof Error ? e.message : String(e)}`, e)
    }
  }
  // 书库自愈（P1-10）：books.jsonl 损坏/移书后启动即扫描重建登记——幂等，完好时
  // changed=false 不写盘；变更时报告供诊断（作者侧零交互）。置于迁移循环前：
  // 先保证登记完整，逐书迁移才遍历得到全部书。
  if (opts.workDir) {
    try {
      const r = repairBooks(opts.workDir)
      if (r.skipped) {
        // M-8（第八轮）：读失败跳过自愈——告警而非报告自愈，防作者误以为登记刚被重建
        // R63-2（十一轮）：登记锁超时同款跳过（另一进程持锁改写中，扫盘整写会与之交错）
        const why =
          r.skipped === 'read-failed'
            ? 'books.jsonl 读取失败（权限或磁盘故障）'
            : 'books.jsonl 登记锁获取超时（另一进程正在改写书库登记）'
        log.warn('repair-books', `${why}，本轮跳过书库自愈（登记未动）`)
        sink.add('repair-books', `${why}，本轮跳过书库自愈（登记未动）`)
      } else if (r.changed) {
        log.warn(
          'repair-books',
          `书库登记已自愈：登记 ${r.rebuilt.length} 条、缺失 ${r.missing.length} 条、重关联 ${r.relinked.length} 条`,
        )
        sink.add(
          'repair-books',
          `书库登记已自愈：重建 ${r.rebuilt.length} 条、缺失 ${r.missing.length} 条、重关联 ${r.relinked.length} 条`,
        )
      }
    } catch (e) {
      noticeOrLog('repair-books', `书库登记自愈失败：${e instanceof Error ? e.message : String(e)}`, e)
    }
  }
  // 版本档案目录迁移：工作区/.snapshots → 工作区/.版本（幂等，旧目录不存在 no-op）
  if (opts.workDir) {
    for (const book of readBooks(opts.workDir)) {
      const bookPath = join(opts.workDir, book.path)
      // M-10（第八轮）：逐书 try/catch——迁移函数内部仍有未收编的抛出点（migrateLayoutV3
      // 的 readdirSync、migrateLayoutV2 的 mkdirSync、migrateLegacyForeshadows 的
      // atomicWriteFile 等）：单本书目录权限故障（备份恢复/同步盘 EACCES）此前会炸整
      // 个服务启动、全部书不可用；一本失败只降级该书（migrateBookDefaults 的先例）。
      try {
        const v2Result = migrateLayoutV2(bookPath)
        if (v2Result.errors.length > 0) {
          noticeOrLog('migrate-layout-v2', `${book.path} 版式 v2 迁移 ${v2Result.errors.length} 个错误：\n${v2Result.errors.join('\n')}`)
        }
        const v3Result = migrateLayoutV3(bookPath)
        if (v3Result.errors.length > 0) {
          noticeOrLog('migrate-layout-v3', `${book.path} 版式 v3 迁移 ${v3Result.errors.length} 个错误：\n${v3Result.errors.join('\n')}`)
        }
        // 版本档案目录迁移：工作区/.snapshots → 工作区/.版本（幂等，旧目录不存在 no-op）
        migrateVersionsDir(bookPath)
        // 伏笔迁移：大纲/伏笔/ → 设定/伏笔/（幂等，旧目录不存在 no-op）
        // R71-14（总七十一轮）：必须在 migrateFinalizedRevisions **之前**——
        // migrateLayoutV2 的清单路径改写已把 大纲/伏笔/* 指到 设定/伏笔/*，但物理
        // 文件靠本函数搬；若定稿基线先跑，伏笔 entry 对 设定/伏笔/* existsSync 落空
        // 被跳过，且幂等闸（任一 document entry 已有基线→整书跳过）此后不再补——
        // git 时代书的伏笔永久缺定稿基线。两函数无相互依赖（本函数不读 manifest，
        // finalize 不碰磁盘搬迁），调序安全
        migrateLegacyForeshadows(bookPath)
        // 定稿基线迁移：旧 git 书库 clean→final / dirty→revision / untracked→draft（幂等）
        migrateFinalizedRevisions(bookPath)
      } catch (e) {
        noticeOrLog('migrate-layout', `${book.path} 启动迁移失败（已跳过该书，不影响其他书）：${e instanceof Error ? e.message : String(e)}`, e)
      }
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
      noticeOrLog('migrate-defaults', `书级默认值迁移整体失败：${e instanceof Error ? e.message : String(e)}`, e)
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
  // T2-4：本 server 进程的书库锁根——双进程开同书时长任务闸走文件锁互斥
  configureTaskGateLockRoot(opts.workDir ? join(opts.workDir, '.clwriting', 'task-gate') : null)
  // R73-49（二十一轮）：ticket 库 per-server 实例（签发/消费两路由在本 buildRoutes 内共享）
  const streamTickets = createStreamTicketStore()
  const routes = buildRoutes(opts.workDir ?? null, studioToken, opts.userDataPath ?? null, isTrustedOrigin, sink, streamTickets)
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
    // X-20（第五十六轮）：请求行 URL 只收 origin-form（以 / 起始）。origin-form 是
    // node http 服务端唯一合法形态；absolute-form（GET http://…/api/*）此前绕过下方
    // /api 前缀判断落静态分支回 200 HTML——入口直接拒 400，不给绕前缀判断的形态留通道。
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) {
      replyError(res, 400, 'BAD_INPUT', 'bad request')
      return
    }
    // DNS rebinding 防御（U-P2-6）：Host 头必须精确匹配本机回环地址 + 实际监听端口。
    // GET 端点无 Origin 头可校验——攻击页把域名二次解析到 127.0.0.1 后，同源 GET
    // 即可全量读取书稿/配置；Host 校验切断该路径（写路径已有 Origin+token 双闸）
    {
      const host = req.headers.host
      if (listeningPort === 0 || (host !== `127.0.0.1:${listeningPort}` && host !== `localhost:${listeningPort}` && host !== `[::1]:${listeningPort}`)) {
        replyError(res, 403, 'FORBIDDEN', 'forbidden host')
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
        replyError(res, 403, 'FORBIDDEN', 'forbidden origin')
        return
      }
      res.writeHead(204)
      res.end()
      return
    }
    // 写端点(POST/PUT/DELETE/PATCH)Origin 校验:非白名单 → 403(防跨站写,即使 CORS 不阻简单请求)
    const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' || req.method === 'PATCH'
    if (isWrite && !isAllowedOrigin(req)) {
      replyError(res, 403, 'FORBIDDEN', 'forbidden origin')
      return
    }
    // 写端点 session token 校验(P0 defense-in-depth):防跨站伪造,无/错 token → 403
    if (isWrite && !safeTokenCompare(req.headers['x-studio-token'], studioToken)) {
      // boot-token 回归断言 error 含 'token'（RB-SV-P2-4 用例），文案保持该词根
      replyError(res, 403, 'FORBIDDEN', '无效或缺失的 studio token')
      return
    }
    // T2-3：GET /api/* 读端点 token 闸。此前只拦写——本机任意进程/被 rebinding 的远端
    // 页面可无凭据全量读取书稿/配置/对话历史（Host 校验只挡远端网页，挡不住本机进程）。
    // 与写闸同源校验（x-studio-token 头，或 query token——SSE/EventSource 不能带头，
    // 与 stream.ts 既有 query 凭据口径一致）、常量时间比较、失败 403 FORBIDDEN 同口径。
    // 豁免清单 = 上方 GET_TOKEN_EXEMPT_PATHS 显式路径表（X-19：原 endsWith('/stream')
    // 后缀匹配是路由命名耦合的静默失闸模式）。
    // R65-46（总六十五轮）：HEAD 与 GET 同读语义，一并入闸——原只判 GET，HEAD /api/*
    // 绕过 token 校验（当前无 HEAD 路由无实害，口径不一致留缺口；响应头同会泄漏
    // 资源元数据）。
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url.startsWith('/api/')) {
      const path = urlPathOnly(req.url)
      if (!GET_TOKEN_EXEMPT_PATHS.some((re) => re.test(path))) {
        // S7（五十九轮）：query token 通道收窄——原 `?token=` 对全部非豁免 GET 通用，
        // token 进 URL 的暴露面（进程列表/代理/服务器日志）比「EventSource 不能带头」
        // 的最小必要面大。现在非豁免 GET 只认 x-studio-token 头（前端 client.ts 契约①
        // 全量 /api/* 已带头）；`?token=`/`?ticket=` 仅在豁免路径（SSE）放行，由
        // stream.ts 自身凭据闸校验（T2 批 ticket 优先 + token 兼容期通道）。
        if (!safeTokenCompare(req.headers['x-studio-token'], studioToken)) {
          replyError(res, 403, 'FORBIDDEN', '无效或缺失的 studio token')
          return
        }
      }
    }

    // API 优先
    // R72-10（二十轮 D-8）：/api/ 判定统一用规范化 pathname——原 raw url startsWith
    // 与 dispatch 的 URL 解析口径双轨（query/编码段/绝对 URI 形态下判定面不一致；
    // token 闸在先无绕过，此为口径统一）。解析失败按非 API 处理。
    const apiPathname = (() => {
      try {
        return new URL(req.url ?? '/', 'http://local').pathname
      } catch {
        return '/'
      }
    })()
    if (apiPathname.startsWith('/api/')) {
      // R64-28（十二轮）：finish 后统一排空未消费请求体——无 body POST（heartbeat/
      // style/rag/chat-branches 等）handler 不读 body 也不 resume，脚本客户端带 body
      // 时 keep-alive 复用被弃（与 stream-ticket.ts 口径一致，收到 dispatch 层统一兜）
      res.on('finish', () => {
        if (!req.readableEnded) req.resume()
      })
      try {
        const matched = await dispatch(req, res, routes)
        if (matched || res.headersSent) return
        replyError(res, 404, 'NOT_FOUND', 'not found')
        return
      } catch (e) {
        if (!res.headersSent) {
          // P3-9：不向客户端泄漏 detail（含文件路径等），仅日志留诊断。M3：只记路径段
          // （SSE token 走 query，完整 url 入日志 = 凭证明文留存 app-*.jsonl）
          log.error('api', 'unhandled error: ' + req.method + ' ' + urlPathOnly(req.url), e)
          replyError(res, 500, 'ERROR', '服务器内部错误')
        }
        return
      }
    }

    // D-4（二十九轮）：/API/ 大写前缀变体此前双失配——上方 GET token 闸与 dispatch 都按
    // 小写 /api/ 匹配，/API/books 一路落进静态分支回 200 index.html（API 路径拿到 SPA
    // 页面，调用方按 JSON 解析报糊墙错误）。静态回退（含静态 miss 落 index.html）前按
    // 小写化口径兜一道：任意大小写的 /api/ 前缀未匹配任何路由 → 统一 404 JSON 错误信封
    // （与 /api/ 未命中同款 replyError），不再落 SPA。排空钩子对齐上方 api 分支（POST
    // /API/* 带 body 被 404 时 keep-alive 连接的未消费请求体照常排空，R64-28 同款）。
    if (apiPathname.toLowerCase().startsWith('/api/')) {
      res.on('finish', () => {
        if (!req.readableEnded) req.resume()
      })
      replyError(res, 404, 'NOT_FOUND', 'not found')
      return
    }

    // 静态托管前端
    // R-8（第十六轮）：静态分支补兜底 catch——对齐 /api 分支口径。createStaticHandler
    // 是 async（返回 promise），对已销毁连接 writeHead 抛 ERR_STREAM_ALREADY_FINISHED
    // 等异步异常此前变成 unhandledRejection（Node ≥15 默认 throw 即进程崩溃）；
    // 若响应尚未结束则 500 IO_ERROR 收尾，重复写头由 headersSent/writableEnded 守卫。
    if (serveStatic) {
      try {
        await serveStatic(req, res)
      } catch (e) {
        log.error('static', 'unhandled error: ' + req.method + ' ' + urlPathOnly(req.url), e)
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          replyError(res, 500, 'IO_ERROR', '服务器内部错误')
        }
      }
      return
    }
    replyError(res, 404, 'NOT_FOUND', 'not found')
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
      // L-S6（第八轮）：与 Host 白名单（认 [::1]:port）对齐——当前 appUrl 固定 127.0.0.1
      // 无实际影响，消两侧不对称漂移点
      allowedOrigins.add(`http://[::1]:${addr.port}`)
      listeningPort = addr.port
    }
  })
  // R64-30（十二轮）：生命周期复位 initialBook 模块态——同进程二次 startServer（dev/
  // 测试形态）此前残留上一实例的 --book 初始书（第二次无 --book 启动仍直达旧书）。
  // 复位点选 close 而非 startServer 入口：调用序铁律是 setInitialBook 先于 startServer
  //（desktop/server-boot.ts 测试锚定），入口清空会抹掉刚注入的值；boot-token 回归
  // 还依赖运行中实例的 live-set 语义（set 后即可读），close 清空两头都保住。
  server.on('close', () => {
    setInitialBook(undefined)
  })
  // R73-49（二十一轮）：票库挂 server 对象——同进程多实例（测试/e2e）按实例取用，
  // 旧实例签发的票随实例隔离，新实例（二次 startServer）零残留零可用
  ;(server as http.Server & { __streamTickets?: StreamTicketStore }).__streamTickets = streamTickets
  return server
}
