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
import { safeTokenCompare, replyError, urlPathOnly, URL_PARSE_BASE } from './http.js'
import { readBooks, repairBooks } from '../../install/books.js'
import { migrateLayoutV2 } from '../../install/migrate-layout-v2.js'
import { migrateLayoutV3 } from '../../install/migrate-layout-v3.js'
import { migrateFinalizedRevisions } from '../../install/migrate-finalized-revision.js'
import { migrateBookDefaults } from '../../install/migrate-defaults.js'
import { migrateLegacyForeshadows } from '../../document/foreshadow.js'
import { migrateVersionsDir } from '../../document/version.js'
import { registerBookRoutes } from './api/books.js'
import { registerRagRoutes } from './api/rag.js'
import { registerRagProviderRoutes } from './api/rag-providers.js'
import { registerHealthRoutes } from './api/health.js'
import { registerFileRoutes } from './api/files.js'
import { registerOverviewRoutes } from './api/overview.js'
import { registerRhythmRoutes } from './api/rhythm.js'
import { registerSettingsRoutes } from './api/settings.js'
import { registerStreamRoutes } from './api/stream.js'
// chat 四端点独立成文件（stream.ts 只辖 SSE/spawn/
// interrupt/auto-write 四职责；chat 段与 SSE 零共享，仅 forgetSseCount 单向依赖）
import { registerChatRoutes } from './api/chat.js'
// closeAllSseConnections：close 收尾断开在途 SSE；
// SSE_STREAM_PATH_PATTERN：GET token 豁免表引用（SSE 端点路径模式单源，
// 与 books.stream 路由及其自带凭据闸同居 stream.ts，改路径只动一处）
import { closeAllSseConnections, SSE_STREAM_PATH_PATTERN } from './api/stream.js'
import { waitInFlightWorkSettled } from './api/in-flight-work.js' // close 收尾有界等在途外部工作
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
// 内置 prompt overlay 升级迁移（startServer 启动期执行一次）
import { migratePromptOverlays } from '../../ai/prompts/resource.js'
import { registerCheckRoutes } from './api/check.js'
import { registerAnalysisRoutes } from './api/analysis.js'
import { registerForeshadowRoutes } from './api/foreshadows.js'
import { registerStyleRoutes } from './api/style.js'
import { registerAiStatusRoutes } from './api/ai-status.js'
import { registerProvidersRoutes } from './api/providers.js'
import { registerTraceStatsRoutes } from './api/trace-stats.js'
import { registerCostStatsRoutes } from './api/cost-stats.js' // llm/call × 价格表聚合
import { registerAuditRoutes } from './api/audit.js'
import { registerChatHistoryRoutes } from './api/chat-history.js'
import { registerChatBranchesRoutes } from './api/chat-branches.js'
import { registerLeadUpdateRoutes } from './api/lead-updates.js'
// task-gate 闸实例注入（书库 .clwriting/task-gate/ 锁根 + 闸表/三审登记表随实例；
// 进程默认实例见 processTaskGate）
import { createTaskGate, processTaskGate, type TaskGate } from './api/task-gate.js'
import type { CommitYield } from '../../learn/commit.js'
import type { ProviderConf, ProbeResult } from '../../ai/provider/index.js'
import { productionDriverHost, type DriverHost } from './driver-port.js'
import { processProviderRuntime, type ProviderRuntime } from '../../ai/provider/store.js'
// mock 快路与 provider 运行时的注入点：选择只在组装根做一次
import { configureRunnerMockFastPath } from '../../ai/runner.js'
import { configureProviderRuntime } from '../../ai/runner.js'
import { setInitialBook } from './api/books.js'
// 启动通告端点——启动链迁移失败对用户可见（App 级横幅数据源）
import { createStartupNoticeSink, registerStartupNoticeRoutes, type StartupNoticeSink } from './api/startup-notices.js'
// 应用信息端点（版本号 + 更新检查结果）+ 起服后延迟一次的更新检查
import { registerAppInfoRoutes } from './api/app-info.js'
import { runUpdateCheckOnce, UPDATE_CHECK_DELAY_MS } from '../../update/check.js'
import { createStaticHandler } from './static.js'
import { initLogging, log, errMsg } from '../../log/index.js'

/** （评审）：路由组装所需的注入面。
 * gate/driver/providers 三件均由组装根（createStudioServer）解析后逐路由显式传递——
 * 模块级可变态（闸表/锁根/三审登记、driver 选择、provider 运行时）不再由路由自取。
 * 收尾：TTL/让出桩/探测桩等测试覆盖档同通道注入（overrides，见下）。 */
interface RouteDeps {
  gate: TaskGate
  driver: DriverHost
  providers: ProviderRuntime
  /** 逐路由测试覆盖档（缺省 {} = 生产口径逐位不变；测试经组装根 opts.overrides 注入） */
  overrides: RouteOverrides
}

/**
 * 收尾（评审 「测试缝渗入生产代码」）：各路由端点 TTL 覆盖档 /
 * 让出桩 / 探测桩的组装根注入面。原 api 层模块级 `__setXxxForTest` / `getXTtlMs`
 * 三件套与 `getProbeForTest` 全部删除，覆盖档随 server 实例经此处传入：
 * - 键缺省（undefined）= 生产口径逐位不变，生产组装恒不传；
 * - 测试在组装时注入（per-server-instance，随实例关闭失效，无跨用例残留）；
 * - TTL 覆盖档经各 register ctx → ttl-cache 的逐调用覆盖尾参生效；
 * - 让出桩/清理桩/探测桩经 ctx 在原消费点位直取（窗口位置不变量随注）。
 */
export interface RouteOverrides {
  /** /state 判态缓存 TTL（缺省 5s） */
  stateTtlMs?: number | null
  /** /tree-issues 缓存 TTL（缺省 5s） */
  treeIssuesTtlMs?: number | null
  /** /health/style 扫描缓存 TTL（缺省 5s） */
  styleScanTtlMs?: number | null
  /** analyze-style 文风语料缓存 TTL（缺省 5s） */
  styleCorpusTtlMs?: number | null
  /** analysis-overview 聚合缓存 TTL（缺省 5s） */
  analysisOverviewTtlMs?: number | null
  /** version-stats 快照统计缓存 TTL（缺省 5s） */
  versionStatsTtlMs?: number | null
  /** /overview 整包缓存 TTL（缺省 5s） */
  overviewTtlMs?: number | null
  /** /search 缓存 TTL（缺省 5s） */
  searchTtlMs?: number | null
  /** /rhythm 聚合缓存 TTL（缺省 5s） */
  rhythmTtlMs?: number | null
  /** /foreshadows 足迹缓存 TTL（缺省 5s） */
  foreshadowTtlMs?: number | null
  /** /settings 聚合缓存 TTL（缺省 5s） */
  settingsTtlMs?: number | null
  /** /completion-names 缓存 TTL（回落链：本档 → settingsTtlMs → 常量 5s） */
  completionNamesTtlMs?: number | null
  /** /learn 缓存 TTL（缺省 5s） */
  learnTtlMs?: number | null
  /** 导出排队等待超时（缺省 10min） */
  exportWaitTimeoutMs?: number | null
  /** 删书墓地后台清理函数（缺省真删） */
  graveyardCleanup?: ((graveAbs: string) => Promise<void>) | null
  /** snapshot restore 读体前让出桩（缺省无让出） */
  snapshotsRestoreYield?: (() => Promise<void>) | null
  /** learn-commit 让出原语桩（缺省 defaultCommitYield） */
  learnCommitYield?: CommitYield | null
  /** provider 探测函数桩（缺省真探测；签名同 透传 userDataPath 口径） */
  probeCapabilities?: ((conf: ProviderConf, userDataPath?: string | null) => Promise<ProbeResult>) | null
}

/** 注册 REST 路由到独立路由表，避免多 server 复用旧 workDir/token 闭包。
 * 注意：注册表按「当前活动路由表」隔离（api/schema.ts WeakMap 键 = RouteTable），
 * 「防跨实例重复声明」由隔离结构本身承担——不得在 withRouteTable 之外调
 * resetRouteSchemas（那清的是外层默认表，生产恒空，属无害冗余）；
 * resetRouteSchemas 函数本身保留（router-schema 测试在用）。 */
function buildRoutes(
  workDir: string | null,
  token: string,
  userDataPath: string | null,
  isTrustedOrigin: (origin: string) => boolean,
  sink: StartupNoticeSink,
  streamTickets: StreamTicketStore,
  deps: RouteDeps,
): RouteTable {
  const routes = createRouteTable()
  withRouteTable(routes, () => {
    const ov = deps.overrides
    // 元：AI 可达性探测（editor/ai 共用，降级体验）
    registerAiStatusRoutes({ userDataPath, driver: deps.driver, providers: deps.providers })
    // 元：启动通告——启动链迁移失败 / 事件库迁移失败的用户可见出口
    registerStartupNoticeRoutes({ sink })
    // 元：应用信息——版本号 + 更新检查结果（前端 App 级横幅数据源）
    registerAppInfoRoutes()

    // ── editor 组（无 driver 依赖；AI 不可达时照常工作）──
    // 收尾：ov.* 为测试覆盖档（缺省 undefined = 生产口径逐位不变）
    registerBookRoutes({ workDir, token, isTrustedOrigin, userDataPath, onStartupNotice: sink.add, gate: deps.gate, driver: deps.driver, graveyardCleanup: ov.graveyardCleanup })
    // RAG 建索引/状态端点——buildIndex 生产入口；
    // 服务商化：书级引用 + 应用级 RAG 服务商（providers.json ragProviders 段）
    registerRagRoutes({ workDir, userDataPath, gate: deps.gate })
    registerRagProviderRoutes({ userDataPath })
    registerHealthRoutes({ workDir, styleScanTtlMs: ov.styleScanTtlMs })
    registerFileRoutes({ workDir, userDataPath }) // PUT /file 覆盖留底读全局保留策略
    registerOverviewRoutes({ workDir, userDataPath, overviewTtlMs: ov.overviewTtlMs }) // 全局托底：genre/target_words/volume_size 喂运行时合并 global.json
    registerRhythmRoutes({ workDir, rhythmTtlMs: ov.rhythmTtlMs })
    registerSettingsRoutes({ workDir, userDataPath, gate: deps.gate, settingsTtlMs: ov.settingsTtlMs, completionNamesTtlMs: ov.completionNamesTtlMs })
    registerDraftRoutes({ workDir, userDataPath })
    registerConfigRoutes({ workDir })
    registerPrefsRoutes({ workDir, userDataPath })
    registerStateRoutes({ workDir, userDataPath, stateTtlMs: ov.stateTtlMs }) // 状态机入口过全局托底链（volume_size 等喂生效值）
    // token 不注入 io/knowledge 两 ctx——注入后零读取（写闸在路由分派前已拦），属死字段
    registerIoRoutes({ workDir, gate: deps.gate, exportWaitTimeoutMs: ov.exportWaitTimeoutMs })
    registerKnowledgeRoutes({ workDir, gate: deps.gate, learnTtlMs: ov.learnTtlMs, learnCommitYield: ov.learnCommitYield })
    registerHeartbeatRoutes({ workDir })
    registerDocumentRoutes({ workDir, userDataPath, gate: deps.gate, driver: deps.driver }) // 伏笔事件族接线（伏笔文档变更落 foreshadow/change）
    registerSnapshotRoutes({ workDir, userDataPath, gate: deps.gate, versionStatsTtlMs: ov.versionStatsTtlMs, snapshotsRestoreYield: ov.snapshotsRestoreYield }) // 版本保留三层链：global.json 全局默认（book.yaml 未设时生效）
    registerSearchRoutes({ workDir, searchTtlMs: ov.searchTtlMs })
    registerCheckRoutes({ workDir, userDataPath, treeIssuesTtlMs: ov.treeIssuesTtlMs }) // 全局托底：机检 short.strict 吃生效值
    registerAnalysisRoutes({ workDir, userDataPath, gate: deps.gate, driver: deps.driver, providers: deps.providers, styleCorpusTtlMs: ov.styleCorpusTtlMs, analysisOverviewTtlMs: ov.analysisOverviewTtlMs })
    registerForeshadowRoutes({ workDir, foreshadowTtlMs: ov.foreshadowTtlMs })
    registerStyleRoutes({ workDir, userDataPath, gate: deps.gate }) // 全局托底：注入强度喂写作链路合并 global.json
    registerProvidersRoutes({ userDataPath, probeCapabilities: ov.probeCapabilities })
    registerTraceStatsRoutes({ workDir, userDataPath })
    registerCostStatsRoutes({ workDir, userDataPath })
    registerAuditRoutes({ workDir, userDataPath, gate: deps.gate })
    registerChatHistoryRoutes({ workDir, userDataPath }) // 对话历史只读端点（editor 组，同 audit 事件读取模式）
    registerChatBranchesRoutes({ workDir, userDataPath }) // 分支列表只读端点（editor 组，分支 UI 服务端支撑）

    // ── ai 组（依赖 driver；AI 不可达时前端置灰）──
    // ticket 库随本实例建，签发与 SSE 消费两侧共享同一份——
    // 票不跨 server 实例残留/消费（对齐路由表 per-server 生命周期）
    registerStreamRoutes({ workDir, userDataPath, studioToken: token, tickets: streamTickets, gate: deps.gate, driver: deps.driver })
    registerChatRoutes({ workDir, userDataPath, gate: deps.gate, driver: deps.driver }) // chat.send/confirm/regenerate/clear
    registerStreamTicketRoutes(streamTickets) // SSE 一次性 ticket 签发（POST 走写闸），token 不再出 URL
    registerOutlineRoutes({ workDir, userDataPath, gate: deps.gate })
    registerLeadUpdateRoutes({ workDir, userDataPath, gate: deps.gate })
    registerReviewRoutes({ workDir, userDataPath, gate: deps.gate, driver: deps.driver, providers: deps.providers })
    registerOnboardRoutes({ workDir, userDataPath, gate: deps.gate })
    registerRewriteRoutes({ workDir, userDataPath, gate: deps.gate })
  })
  return routes
}

/**
 * GET token 闸豁免清单——显式路径表（精确模式匹配）。不得改回后缀匹配：
 * `path.endsWith('/stream')` 会让任何尾段恰为 /stream 的端点（含将来新增的路由命名
 * 撞车）静默失闸。豁免面仅两条精确模式：
 * - /api/boot：前端无 token 时的 bootstrap 通道，token 本身由它下发；
 * - /api/books/:name/stream：SSE 端点（EventSource 不能带头），经此处放行后由
 * stream.ts 自带的凭据闸校验（一次性 ticket / x-studio-token 头， 起
 * `?token=` 通道已删）；name 为单路径段（[^/]+），与 router.ts:param 捕获口径一致。
 * SSE 豁免项引 stream.ts 导出的 SSE_STREAM_PATH_PATTERN（单源）——此处不手写等价
 * 正则（两处正则字符串耦合时，路由路径改动会令豁免表静默失配）；/api/boot 项本文件
 * 自持（bootstrap 端点注册面不在 stream.ts）。
 * 健康检查无独立顶层端点（health.ts 为书级业务端点，不豁免）；非 /api/ 静态资源不受影响。
 * 本常量须保持导出：test 侧 fetch 包装的豁免抄本同步守卫
 * （test/governance/studio-token-exempt-sync.test.ts）读本正本比对——
 * 闸消费点仅下方 GET/HEAD token 闸一处。
 */
export const GET_TOKEN_EXEMPT_PATHS: readonly RegExp[] = [/^\/api\/boot$/, SSE_STREAM_PATH_PATTERN]

/** close 收尾等「在途外部工作」（重建/导出/扫描 Worker 线程）settle 的
 *  有界预算——超时放行，与 graceful-shutdown 的 settle/close 超时同口径（close 只
 *  需覆盖该进程内最长的单次 worker 收尾，不追求覆盖全量重建）。 */
const CLOSE_FLUSH_BUDGET_MS = 2_000

export interface StudioServerOptions {
  port: number
  host?: string
  /** 前端构建产物目录；缺省则不托管静态（仅 API） */
  staticDir?: string
  /** CLWriting 工作目录（含 .clwriting/）；null/缺省 = 未定位，书架将为空 + 提示 */
  workDir?: string | null
  /** APP 级数据目录（Electron userData / CLI 约定路径）；全局偏好 JSON 存储位置 */
  userDataPath?: string | null
  /** 日志是否镜像 console——dev/CLI 态 true（看得见）；Electron 打包态
   *  console 输出到无人看见的地方，传 false 只落 JSONL。缺省 true。 */
  mirrorConsoleLog?: boolean
  /** studio 会话 token（唯一红线豁免）：缺省 randomUUID 行为不变；
   *  Electron 拆分形态由 main 侧 server-manager 持久化注入（跨崩溃重启稳定——前端
   *  token 仅挂载时取一次，换代即写/SSE/心跳永久 403）。协议语义零改动。 */
  studioToken?: string
  /** 收尾：逐路由测试覆盖档（TTL / 让出桩 / 探测桩 / 墓地清理桩）。
 * 缺省 = 生产口径逐位不变；测试经组装根注入，随实例隔离（见 RouteOverrides）。 */
  overrides?: RouteOverrides
}

/**
 * 组装根依赖（显式注入面）。
 *
 * 所有权与缺省：
 * - `taskGate`：闸实例（锁根 + 进程内闸表 + 三审登记表）。缺省 = 本工厂**新建**一个
 *   实例（锁根取 `opts.workDir`）——故同进程两个 server 的闸互不可见。生产组装
 *   （startServer）显式传入进程默认实例：非路由消费方（退出链 graceful-shutdown 的
 *   「等闸释放」、ai 侧 task-gate 端口）按模块级函数取用同一份闸表。
 * - `driver`：driver 宿主（必需能力面 + 会话存取 + mock 选择结果）。缺省 = 生产宿主
 *   （读 CLWRITING_DRIVER 选实现，全仓唯一读取点）。测试在组装时传自己的宿主
 *   （如 mock driver / 隔离会话表）即完成注入，runner 不再自判环境变量。
 * - `providers`：provider 运行时端口（读侧决策面 + 降级记忆回调注册面）。缺省 =
 *   进程单例（store 模块实现）。构造时经 configureProviderRuntime 注入给 AI 执行器。
 */
export interface StudioServerDeps {
  taskGate?: TaskGate
  driver?: DriverHost
  providers?: ProviderRuntime
}

/** 组装产物句柄：显式 close 语义 + 解析后的依赖（只读，供上层按实例取用）。 */
export interface StudioServerHandle {
  /** Node http.Server（listen 已发起；listening / error 由调用方管） */
  readonly server: http.Server
  /**
   * 关停（原 server.close 猴补的显式化，语义逐位不变）：
   * ① 断开全部在途 SSE（长连接响应不会自行 end，否则 close 回调被悬置到调用方超时）；
   * ② 调底层 close；
   * ③ close 事件到后再于有界预算内等「在途外部工作」（重建/导出/扫描 Worker 线程）settle
   * 才回调——客户端先断开而 handler 仍 await Worker 时，连接清空即触发回调会让调用方
   * 立刻 rmSync 在 Windows 落 ENOTEMPTY。预算耗尽即放行（绝不无限期阻塞）；
   * err 原样透传（未监听等既有错误语义不变）。
   */
  close(cb?: (err?: Error) => void): void
  /** 本实例实际使用的依赖（组装根解析结果） */
  readonly deps: Required<StudioServerDeps>
  /** 本实例的 SSE 一次性 ticket 库（签发/消费两侧同实例共享） */
  readonly tickets: StreamTicketStore
}

/** 起 server 并监听（返回 http.Server，由调用方管 listening / error / 关闭）。
 *
 *  生产组装根：进程级单例依赖（闸 / driver 宿主 / provider 运行时）+ 兼容既有调用方的
 *  http.Server 形态（close 语义挂在 server.close 上——调用方是退出链与既有测试）。
 *  需要实例级依赖注入（测试、同进程多实例）请直接用 createStudioServer。 */
export function startServer(opts: StudioServerOptions): http.Server {
  const gate = processTaskGate()
  // 本 server 进程的书库锁根——双进程开同书时长任务闸走文件锁互斥
  gate.configureLockRoot(opts.workDir ? join(opts.workDir, '.clwriting', 'task-gate') : null)
  const handle = createStudioServer(opts, { taskGate: gate, driver: productionDriverHost(), providers: processProviderRuntime() })
  // 兼容形态：把句柄的 close 语义挂到 server 对象上（见 StudioServerHandle.close 注释）
  const rawClose = handle.server.close.bind(handle.server)
  handle.server.close = ((cb?: (err?: Error) => void) => {
    closeSseThenSettle(rawClose, cb)
    return handle.server
  }) as typeof handle.server.close
  return handle.server
}

/** 关停收尾（句柄与兼容壳共用的实现体）：断 SSE → close → 有界等 Worker settle → 回调。 */
function closeSseThenSettle(
  rawClose: (cb?: (err?: Error) => void) => http.Server,
  cb?: (err?: Error) => void,
): void {
  closeAllSseConnections()
  rawClose((err?: Error) => {
    void waitInFlightWorkSettled(CLOSE_FLUSH_BUDGET_MS).finally(() => cb?.(err))
  })
}

/**
 * 组装并起 server（组装根）：迁移/自愈启动链 → 依赖解析 → 路由注册 →
 * 监听。deps 缺省即生产口径（driver 宿主读 CLWRITING_DRIVER 选择实现；闸与 provider
 * 运行时按实例新建/进程单例，见 StudioServerDeps）。
 */
export function createStudioServer(opts: StudioServerOptions, deps: StudioServerDeps = {}): StudioServerHandle {
  const studioToken = opts.studioToken ?? randomUUID()
  // 依赖解析（组装根唯一选择点）：
  // - 闸：显式传入者胜（生产 = 进程默认实例）；缺省按本实例 workDir 新建（同进程多实例隔离）
  // - driver：显式传入者胜；缺省生产宿主（环境变量唯一读取点在此宿主内）
  // - provider 运行时：显式传入者胜；缺省进程单例。注入给 AI 执行器的回调注册面 + mock 快路
  const driver = deps.driver ?? productionDriverHost()
  const gate = deps.taskGate ?? createTaskGate({ lockRoot: opts.workDir ? join(opts.workDir, '.clwriting', 'task-gate') : null, driver })
  const providers = deps.providers ?? processProviderRuntime()
  configureProviderRuntime(providers)
  configureRunnerMockFastPath(driver.kind === 'mock')
  // 结构化日志——JSONL 按天落 userData/logs/，未提供 userDataPath 时
  // 保持纯 console 镜像（与引入前行为一致）。desktop main 可能已提前 init（幂等）。
  initLogging({
    logsDir: opts.userDataPath ? join(opts.userDataPath, 'logs') : null,
    mirrorConsole: opts.mirrorConsoleLog ?? true,
  })
  // 启动链通告收集——迁移失败不再是「console 失明出口」，统一进
  // startupNotices 供 /api/startup-notices + App 横幅消费
  const sink = createStartupNoticeSink()
  const noticeOrLog = (kind: string, message: string, err?: unknown): void => {
    sink.add(kind, message)
    log.error(kind, message, err)
  }
  // 内置 prompt overlay 升级迁移（幂等——未改动的旧版拷贝升级为当前内置，
  // 用户改过的原样保留；「升级不覆盖用户改动」的落点）
  if (opts.userDataPath) {
    try {
      const r = migratePromptOverlays(opts.userDataPath)
      // 信息性留痕（非故障，不进横幅）：作者可见性无诉求，日志留诊断即可
      if (r.upgraded.length > 0) {
        log.warn('migrate-prompts', `已升级未改动 prompt 副本：${r.upgraded.join(', ')}`)
      }
    } catch (e) {
      noticeOrLog('migrate-prompts', `prompt overlay 迁移失败：${errMsg(e)}`, e)
    }
  }
  // 书库自愈：books.jsonl 损坏/移书后启动即扫描重建登记——幂等，完好时
  // changed=false 不写盘；变更时报告供诊断（作者侧零交互）。置于迁移循环前：
  // 先保证登记完整，逐书迁移才遍历得到全部书。
  // 维持同步版：repairBooks 的 books.lock 同步等待发生在本启动段
  //（createServer/listen 之前、零请求在途），阻塞仅推迟首请求可处理时刻，不触达
  // SSE/HTTP 响应性——startServer 契约同步返回 http.Server，异步化
  // 级联全部测试 boot 面，不成比例。
  if (opts.workDir) {
    try {
      const r = repairBooks(opts.workDir)
      if (r.skipped) {
        // 读失败 / 登记锁超时跳过自愈——告警而非报告自愈（防作者误以为登记刚被重建；
        // 另一进程持锁改写中，扫盘整写会与之交错）
        const why =
          r.skipped === 'read-failed'
            ? 'books.jsonl 读取失败（权限或磁盘故障）'
            : 'books.jsonl 登记锁获取超时（另一进程正在改写书库登记）'
        log.warn('repair-books', `${why}，本轮跳过书库自愈（登记未动）`)
        sink.add('repair-books', `${why}，本轮跳过书库自愈（登记未动）`)
      } else if (r.changed) {
        // missing 有幽灵条目时随通告带回可操作提示（自愈只报告
        // 不清除，作者按提示人工修复或移回原位）
        const hint = r.missingHint ? `\n${r.missingHint}` : ''
        log.warn(
          'repair-books',
          `书库登记已自愈：登记 ${r.rebuilt.length} 条、缺失 ${r.missing.length} 条、重关联 ${r.relinked.length} 条${hint}`,
        )
        sink.add(
          'repair-books',
          `书库登记已自愈：重建 ${r.rebuilt.length} 条、缺失 ${r.missing.length} 条、重关联 ${r.relinked.length} 条${hint}`,
        )
      }
    } catch (e) {
      noticeOrLog('repair-books', `书库登记自愈失败：${errMsg(e)}`, e)
    }
  }
  // 版本档案目录迁移：工作区/.snapshots → 工作区/.版本（幂等，旧目录不存在 no-op）
  if (opts.workDir) {
    for (const book of readBooks(opts.workDir)) {
      const bookPath = join(opts.workDir, book.path)
      // 逐书 try/catch——迁移函数内部有未收编的抛出点（migrateLayoutV3
      // 的 readdirSync、migrateLayoutV2 的 mkdirSync、migrateLegacyForeshadows 的
      // atomicWriteFile 等）：单本书目录权限故障（备份恢复/同步盘 EACCES）会炸整
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
        // 必须在 migrateFinalizedRevisions **之前**——
        // migrateLayoutV2 的清单路径改写已把 大纲/伏笔/* 指到 设定/伏笔/*，但物理
        // 文件靠本函数搬；若定稿基线先跑，伏笔 entry 对 设定/伏笔/* existsSync 落空
        // 被跳过，且幂等闸（任一 document entry 已有基线→整书跳过）此后不再补——
        // git 时代书的伏笔永久缺定稿基线。两函数无相互依赖（本函数不读 manifest，
        // finalize 不碰磁盘搬迁），调序安全
        migrateLegacyForeshadows(bookPath)
        // 定稿基线迁移：旧 git 书库 clean→final / dirty→revision / untracked→draft（幂等）
        migrateFinalizedRevisions(bookPath)
      } catch (e) {
        noticeOrLog('migrate-layout', `${book.path} 启动迁移失败（已跳过该书，不影响其他书）：${errMsg(e)}`, e)
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
      noticeOrLog('migrate-defaults', `书级默认值迁移整体失败：${errMsg(e)}`, e)
    }
  }
  // v4 存量规范形迁移**已裁决拆除**——RC 阶段无存量用户
  // 书库（唯一测试库实测已全规范），写路径收口 + 读侧容忍 + NFC 创建点已覆盖全部保证；
  // 「启动即改写用户数据」的长期风险面大于无受众的收益。裁决记档见
  // Dev/Docs/Archive/书库平台规范化-实施方案-.md §一 D。
  // Origin 白名单只含实际监听 origin（下方 listening 补，同源放行）；
  // dev Vite(5173) 仅 CLW_DEV_UI/CLW_DEV_CORS 显式开启时注入（scripts/dev-api.ts 设 env，
  // dev:web/dev:app 链路保持可用）——生产态不再放行本地任意监听 5173 的页面。
  const allowedOrigins = new Set<string>()
  if (process.env['CLW_DEV_UI'] === '1' || process.env['CLW_DEV_CORS'] === '1') {
    allowedOrigins.add('http://127.0.0.1:5173')
    allowedOrigins.add('http://localhost:5173')
  }
  const isTrustedOrigin = (origin: string): boolean => allowedOrigins.has(origin)
  // 本实例书库锁根已随闸实例解析（显式 deps.taskGate 或上方缺省新建时配置）——
  // 不再有模块级 configureTaskGateLockRoot 调用：锁根归属闸实例。
  // ticket 库 per-server 实例（签发/消费两路由在本 buildRoutes 内共享）
  const streamTickets = createStreamTicketStore()
  const routes = buildRoutes(opts.workDir ?? null, studioToken, opts.userDataPath ?? null, isTrustedOrigin, sink, streamTickets, { gate, driver, providers, overrides: opts.overrides ?? {} })
  // host 仅限本机回环（本文件头注释），非回环值启动即拒——
  // 否则 Host 白名单硬编码回环，传非回环 host 时全请求 403（参数存在即故障）；
  // fail-fast 优于逐请求 403 的静默失效。
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
    // 请求体排空钩子为入口单挂点（必须先于任何 replyError/return）。为什么：带 body 的
    // 请求被闸拒绝后 body 滞留，在无核心自动排空的运行时（Electron 内嵌 Node / CI node 24；
    // node ≥25 核心才在响应 finish 后自动 resume 未消费 body）上 keep-alive 连接无法解析
    // 下一请求被整条弃掉——六处闸拒绝路径（bad request 400 / Host 403 / OPTIONS 204 /
    // 写 Origin 403 / 写 token 403 / GET token 403）逐一挂载必漏。readableEnded 守卫下
    // 只 resume 未消费的请求流，不改变任何响应行为；全路径恰好挂一次，也消除多分支
    // 重复挂载的多次 resume。
    res.on('finish', () => {
      if (!req.readableEnded) req.resume()
    })
    // 请求行 URL 只收 origin-form（以 / 起始，node http 服务端唯一合法形态）。
    // absolute-form（GET http://…/api/*）会绕过下方 /api 前缀判断落静态分支回 200 HTML
    // ——入口直接拒 400，不给绕前缀判断的形态留通道。
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) {
      replyError(res, 400, 'BAD_INPUT', 'bad request')
      return
    }
    // DNS rebinding 防御：Host 头必须精确匹配本机回环地址 + 实际监听端口。
    // GET 端点无 Origin 头可校验——攻击页把域名二次解析到 127.0.0.1 后，同源 GET
    // 即可全量读取书稿/配置；Host 校验切断该路径（写路径已有 Origin+token 双闸）
    {
      // reqHost 命名与外层监听 host 区分——两者同名异义（请求头 vs 监听参数）易读混
      const reqHost = req.headers.host
      if (listeningPort === 0 || (reqHost !== `127.0.0.1:${listeningPort}` && reqHost !== `localhost:${listeningPort}` && reqHost !== `[::1]:${listeningPort}`)) {
        replyError(res, 403, 'FORBIDDEN', 'forbidden host')
        return
      }
    }
    const origin = req.headers.origin
    // CORS:只对白名单 Origin 设 ACAO(跨站浏览器读被阻)
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      // allow-methods 必须与上下方闸的放行集合一致：下方写闸（isWrite）把 PATCH 纳入
      // Origin/token 校验，清单漏项则浏览器对 PATCH（非简单方法）先发预检、预检通过后
      // 实际请求仍被浏览器按 CORS 拒发——服务端放行口径与预检清单失配即静默失效。
      // HEAD 同理：dev 跨源形态（Vite 5173 → SSE 直连 DEV_API_BASE 7878）下 SSE 名额
      // 探测是带 x-studio-token 头的 HEAD（该头非 CORS 安全列表头 → 必预检），清单不含
      // HEAD 时浏览器直接拒发，429 指引在 dev 静默丢失（服务端放行口径与预检清单必须一致）。
      res.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PUT,DELETE,PATCH,OPTIONS')
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
    // 写端点 session token 校验(defense-in-depth):防跨站伪造,无/错 token → 403
    if (isWrite && !safeTokenCompare(req.headers['x-studio-token'], studioToken)) {
      // 文案须保留 'token' 词根（boot-token 回归断言 error 含 'token'）
      replyError(res, 403, 'FORBIDDEN', '无效或缺失的 studio token')
      return
    }
    // GET/HEAD /api/* 读端点 token 闸：不拦则本机任意进程/被 rebinding 的远端
    // 页面可无凭据全量读取书稿/配置/对话历史（Host 校验只挡远端网页，挡不住本机进程）。
    // HEAD 与 GET 同读语义，一并入闸（原只判 GET 则 HEAD /api/* 绕过 token 校验，
    // 响应头同会泄漏资源元数据）。
    // 与写闸同源校验（x-studio-token 头；query token 通道已全量下线—— 收窄非豁免
    // GET 只认头， 起 SSE 豁免路径的 `?token=` 亦删，凭据只走 ticket/头）、
    // 常量时间比较、失败 403 FORBIDDEN 同口径。
    // 豁免清单 = 上方 GET_TOKEN_EXEMPT_PATHS 显式路径表（不得改回后缀匹配）。
    // API 优先
    // apiPathname（规范化）必须在 GET/HEAD token 闸之前算好，且与 dispatch 同口径：
    // llhttp 不归一化请求行，`GET /foo/../api/books` 的 raw url 不含 `/api/` 前缀，
    // 用 raw url 判前缀会跳过 token 闸，而规范化 pathname 命中 `/api/` → 无凭据进路由
    //（实测 200 无凭据读全部读端点；`%2e%2e` 编码点段同效）。解析失败按非 API 处理。
    // 闸与豁免表用同一规范化口径（WHATWG URL 归一化点段），豁免匹配同步换
    // apiPathname（new URL.pathname 已剥 query，urlPathOnly 职责内含）。写闸在一切
    // 路径判定之前不受影响；SSE 豁免路径自带凭据闸。
    const apiPathname = (() => {
      try {
        // base 单源化——引 http.ts URL_PARSE_BASE（与 parseRequestUrl 同一 base，
        // 避免两处字面量漂移）
        return new URL(req.url ?? '/', URL_PARSE_BASE).pathname
      } catch {
        return '/'
      }
    })()
    if ((req.method === 'GET' || req.method === 'HEAD') && apiPathname.startsWith('/api/')) {
      if (!GET_TOKEN_EXEMPT_PATHS.some((re) => re.test(apiPathname))) {
        // query token 通道收窄——非豁免 GET 只认 x-studio-token 头（前端 client.ts 契约①
        // 全量 /api/* 已带头）；`?token=` 对全部非豁免 GET 通用会让 token 进 URL 的暴露面
        //（进程列表/代理/服务器日志）远超「EventSource 不能带头」的最小必要面。
        // 仅 `?ticket=` 在豁免路径（SSE）放行，由 stream.ts 自身凭据闸校验；
        // `?token=` 通道已两端同删（前后端同包同版发布，无过渡兼容对象）。
        if (!safeTokenCompare(req.headers['x-studio-token'], studioToken)) {
          replyError(res, 403, 'FORBIDDEN', '无效或缺失的 studio token')
          return
        }
      }
    }

    if (apiPathname.startsWith('/api/')) {
      // finish 后排空钩子已上提为入口单挂点（见回调顶部）
      try {
        const matched = await dispatch(req, res, routes)
        if (matched || res.headersSent) return
        replyError(res, 404, 'NOT_FOUND', 'not found')
        return
      } catch (e) {
        if (!res.headersSent) {
          // 不向客户端泄漏 detail（含文件路径等），仅日志留诊断；且只记路径段
          // （SSE token 走 query，完整 url 入日志 = 凭证明文留存 app-*.jsonl）
          log.error('api', 'unhandled error: ' + req.method + ' ' + urlPathOnly(req.url), e)
          replyError(res, 500, 'ERROR', '服务器内部错误')
        }
        return
      }
    }

    // /API/ 大写前缀（含裸 /api，无尾斜杠）在静态回退前兜一道：上方 GET token 闸与
    // dispatch 都按小写 /api/ 匹配，大写变体未匹配任何路由会落进静态分支回 200
    // index.html（API 路径拿到 SPA 页面，调用方按 JSON 解析报糊墙错误）。统一 404 JSON
    // 错误信封（与 /api/ 未命中同款 replyError），不再落 SPA。
    // POST /API/* 带 body 被 404 时，keep-alive 连接的未消费请求体由入口单挂点排空（同口径）。
    const apiLower = apiPathname.toLowerCase()
    if (apiLower === '/api' || apiLower.startsWith('/api/')) {
      replyError(res, 404, 'NOT_FOUND', 'not found')
      return
    }

    // 静态托管前端
    // 静态分支兜底 catch（对齐 /api 分支口径）：createStaticHandler
    // 是 async（返回 promise），对已销毁连接 writeHead 抛 ERR_STREAM_ALREADY_FINISHED
    // 等异步异常不接即 unhandledRejection（Node ≥15 默认 throw 即进程崩溃）；
    // 若响应尚未结束则 500 'IO' 收尾，重复写头由 headersSent/writableEnded 守卫。
    if (serveStatic) {
      try {
        await serveStatic(req, res)
      } catch (e) {
        log.error('static', 'unhandled error: ' + req.method + ' ' + urlPathOnly(req.url), e)
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          replyError(res, 500, 'IO', '服务器内部错误') // 统一 'IO' 错误码
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
  // requestTimeout 显式钉 300s，不得删：408 闲置超时设计（readJson
  // BODY_IDLE_TIMEOUT_MS=30s 的占闸上限语义）与前端 ~300s 自愈假设均以 300s 为前提
  //（见 http.ts 注）；只依赖 Node 缺省值（当前恰 300s）则无锚可依、跨版本漂移即翻车。
  server.requestTimeout = 300_000
  server.listen(opts.port, host)
  // 起服后延迟一次更新检查（fire-and-forget——不 await、不阻塞监听，
  // 也不进启动关键路径）。timer 显式 unref：否则「只起 server 不求请求」的进程
  //（单测/脚本形态）会被这枚待触发定时器多留住数秒；close 时清掉（实例关灯后
  // 不再出站）。检查内部自带开关短路与静默（CLW_DISABLE_UPDATE_CHECK=1 → 不打网），
  // 失败不抛——此处无需 try/catch。
  let updateCheckTimer: NodeJS.Timeout | null = setTimeout(() => {
    updateCheckTimer = null
    void runUpdateCheckOnce()
  }, UPDATE_CHECK_DELAY_MS)
  updateCheckTimer.unref?.()
  // listening 后补实际端口(port 0 随机端口)
  server.on('listening', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      allowedOrigins.add(`http://127.0.0.1:${addr.port}`)
      allowedOrigins.add(`http://localhost:${addr.port}`)
      // 与 Host 白名单（认 [:1]:port）对齐——消两侧不对称漂移点
      allowedOrigins.add(`http://[::1]:${addr.port}`)
      listeningPort = addr.port
    }
  })
  // 生命周期复位 initialBook 模块态——不复位则同进程二次 startServer（dev/
  // 测试形态）残留上一实例的 --book 初始书（第二次无 --book 启动仍直达旧书）。
  // 复位点选 close 而非 startServer 入口：调用序铁律是 setInitialBook 先于 startServer
  //（desktop/server-boot.ts 测试锚定），入口清空会抹掉刚注入的值；boot-token 回归
  // 还依赖运行中实例的 live-set 语义（set 后即可读），close 清空两头都保住。
  server.on('close', () => {
    setInitialBook(undefined)
    // 清掉尚未触发的更新检查定时器（关灯后不再出站）
    if (updateCheckTimer) {
      clearTimeout(updateCheckTimer)
      updateCheckTimer = null
    }
    // 模块生命周期终态断开全部在途 SSE——幂等（close 包装已先断一次）。
    closeAllSseConnections()
  })
  // 关停语义不再是本体里的 server.close 猴补：由句柄 close 承载
  //（实现体见 closeSseThenSettle；语义与猴补前逐位一致）。startServer 兼容壳再把
  // 它挂回 server.close，供既有调用方（退出链/测试）按 http.Server 形态使用。
  const rawClose = server.close.bind(server)
  const close = (cb?: (err?: Error) => void): void => closeSseThenSettle(rawClose, cb)
  // ticket 库挂 server 对象——同进程多实例（测试/e2e）按实例取用，
  // 旧实例签发的票随实例隔离，新实例（二次 startServer）零残留零可用
  ;(server as http.Server & { __streamTickets?: StreamTicketStore }).__streamTickets = streamTickets
  return { server, close, deps: { taskGate: gate, driver, providers }, tickets: streamTickets }
}
