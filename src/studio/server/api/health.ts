/**
 * 体检 REST 端点（#12.3 + 7.1）。
 *
 * - GET /api/books/:name/health/style        文风（aggregateStyleTrend → StyleTrend）
 * - GET /api/books/:name/health/event-store  事件库体积只读读数（statSync 文件尺寸 + 超阈标记）
 *
 * 复用内核聚合函数，直接返结构化对象（不走人话 format）。后端零新增逻辑。
 * 空书（count=0）照常返对象，前端渲染空态。
 */
import { statSync } from 'node:fs'
import { defineRoute } from './schema.js'
import { reply } from '../http.js'
import { createTtlProbeCache } from '../ttl-cache.js'
import { registerBookKeyedCache } from '../../../shared/cache-registry.js' // 书键缓存登记表（登记制单源）
import { readKind, resolveBookOrReply } from '../book-context.js'
import { scanChaptersAsync, aggregateStyleTrend, readBaseline, type ChapterSample } from '../../../metrics/style.js'
import { sessionDbPath } from '../../../events/store.js'
// 体积阈值单源：事件库维护族（store-retention）那条判据，本端点只读不另抄一份数字
import { getEventStoreBytesWarnThreshold } from '../../../events/store-retention.js'

interface HealthCtx {
  workDir: string | null
  /** APP 级数据目录：事件库路径按「数据目录 + 书根 hash」推导，未配置时体积读数缺省 */
  userDataPath: string | null
  /** 收尾：文风扫描缓存 TTL 覆盖档——组装根 RouteOverrides 注入
   * （undefined = 生产口径 5s 逐位不变） */
  styleScanTtlMs?: number | null
}

/** 事件库体积读数（体积面健康项）。 */
export interface EventStoreFootprint {
  /** 主库文件字节数（statSync）；null = 数据目录未配置 / 库文件不在位 / 读取失败 */
  bytes: number | null
  /** 超阈标记（判据在服务端按阈值单源现算，前端不另算） */
  overThreshold: boolean
  /** 超阈判据的字节阈值（同一单源），供前端渲染人话指引 */
  warnThresholdBytes: number
}

/**
 * 体积只读探测：**只 statSync 库文件尺寸，不为显示体积开库连接**——在 WAL 库上开只读连接会落
 * 下关连接也不回收的 `-wal`/`-shm` 侧车，而库文件指纹正是 stats 端点结果缓存的失效判据
 * （见 events/store-retention.ts 文件头的「只读连接不得用来探路」）。
 *
 * **条数不在此显示**：现成的行数观测只有 observeEventStoreSize 的 MAX(seq) 近似，而它必须挂在
 * **已开**连接上；端点侧没有既开连接，为显示条数另开只读连接读 COUNT(*)/MAX(seq) 正是上面那条
 * 纪律禁止的形态——故体积面只报字节数，行数仍只在维护路径的日志留痕里可见。
 *
 * 读失败（库不在位/权限）按「读数缺省」处理：观测面不反噬端点，前端渲染空态。
 */
function readEventStoreFootprint(userDataPath: string | null, bookRoot: string): EventStoreFootprint {
  const warnThresholdBytes = getEventStoreBytesWarnThreshold()
  let bytes: number | null = null
  if (userDataPath) {
    try {
      bytes = statSync(sessionDbPath(userDataPath, bookRoot)).size
    } catch {
      bytes = null
    }
  }
  return { bytes, overThreshold: bytes !== null && bytes >= warnThresholdBytes, warnThresholdBytes }
}

// 内存闸（审计）：scanChapters 每请求全书扫描（读全部定稿章 + 逐章算指纹），
// 体检页轮询/反复刷新会反复重扫。缓存口径对齐 overview.ts stateCache：5s TTL + 书键 Map
// FIFO 上限；overview 本身无写路径失效挂点（纯 TTL，概览页 stale 5s 可接受），此处同口径——
// 保存/定稿后最迟 5s 自愈，不做即时失效。
/** 删书/改名失效挂点——书键缓存随书生命周期正向失效（books.ts
 *  清理清单接线；TTL 5s 仍为兜底自愈）。 */
export function forgetStyleScanCache(bookRoot: string): void {
  styleScanCache.forget(bookRoot)
}

// 登记制（模块顶层自登记）：删/改名后同名重建书不读陈体检扫描结果（TTL 5s 兜底自愈）。
registerBookKeyedCache('health-style-scan', forgetStyleScanCache)
/** 导出供测试派生 sleep 时长——测试侧 5300 魔数与 TTL 双处
 * 硬编码，TTL 调大时「失效重扫」用例静默变假（仍在 TTL 内 → 断言 count=2 假红）。 */
export const STYLE_SCAN_TTL = 5000
/** 收尾：__styleScanCacheHasForTest / __setStyleScanTtlForTest 删除——
 * 缓存实例即观测面（生产对象，先例同 analysisOverviewCache）：has/TTL 覆盖档
 * （组装根 RouteOverrides 注入，随实例隔离）取代模块级钩子。 */
const STYLE_SCAN_MAX = 32

/** 缓存壳收编 ttl-cache.ts 通用件（原本地 Map + FIFO +
 * 过期逐出本地壳删除；命中/失效时序/逐出序逐位不变——纯 TTL + 异步计算 +
 * FIFO 32 ts 取写入当刻由通用件 store 统一承担，见其头部收敛映射表）。 */
export const styleScanCache = createTtlProbeCache<string, ChapterSample[]>({
  name: 'health-style-scan',
  keyOf: (k) => k,
  max: STYLE_SCAN_MAX,
  ttl: () => STYLE_SCAN_TTL,
  computeAsync: (bookRoot) => scanChaptersAsync(bookRoot),
})

/** 注册体检路由（server 启动时调用一次） */
export function registerHealthRoutes(ctx: HealthCtx): void {
  // 文风
  defineRoute('books.health.style', {
    method: 'GET',
    path: '/api/books/:name/health/style',
    handler: async ({ params }, _req, res) => {
      // SRV-：resolveBook 双行样板收编单源
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      const kind = readKind(r.bookRoot)
      // 命中短时缓存则跳过全书扫描（samples 为纯数据可复用；聚合与基线读取廉价，每次现算）
      // miss 扫描切异步孪生——同步 scanChapters 在 200 万字大书上
      // 秒级冻结事件循环（同族漏网点），逐 25 章让出对齐 analysis/learn 范式
      // 收尾：TTL 覆盖档经 ctx（组装根 RouteOverrides）逐调用传入
      const samples = await styleScanCache.get(r.bookRoot, undefined, ctx.styleScanTtlMs ?? undefined)
      reply(res, 200, aggregateStyleTrend(samples, kind, readBaseline(r.bookRoot)))
    },
  })

  // 事件库体积：作者可见的「应用为什么越来越大」出口（无书库文件时字段为 null，不抛）
  defineRoute('books.health.event-store', {
    method: 'GET',
    path: '/api/books/:name/health/event-store',
    handler: ({ params }, _req, res) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      reply(res, 200, { ok: true, eventStore: readEventStoreFootprint(ctx.userDataPath, r.bookRoot) })
    },
  })
}
