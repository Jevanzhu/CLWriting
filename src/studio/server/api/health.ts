/**
 * 体检 REST 端点（#12.3 + 7.1）。
 *
 * - GET /api/books/:name/health/style     文风（aggregateStyleTrend → StyleTrend）
 *
 * 复用内核聚合函数，直接返结构化对象（不走人话 format）。后端零新增逻辑。
 * 空书（count=0）照常返对象，前端渲染空态。
 */
import { defineRoute } from './schema.js'
import { reply } from '../http.js'
import { createTtlProbeCache } from '../ttl-cache.js'
import { readKind, resolveBookOrReply } from '../book-context.js'
import { scanChaptersAsync, aggregateStyleTrend, readBaseline, type ChapterSample } from '../../../metrics/style.js'

interface HealthCtx {
  workDir: string | null
  /** 收尾：文风扫描缓存 TTL 覆盖档——组装根 RouteOverrides 注入
 * （undefined = 生产口径 5s 逐位不变） */
  styleScanTtlMs?: number | null
}

// 内存闸：scanChapters 每请求全书扫描（读全部定稿章 + 逐章算指纹），
// 体检页轮询/反复刷新会反复重扫。缓存口径对齐 overview.ts stateCache：5s TTL + 书键 Map
// FIFO 上限；overview 本身无写路径失效挂点（纯 TTL，概览页 stale 5s 可接受），此处同口径——
// 保存/定稿后最迟 5s 自愈，不做即时失效。
/** 删书/改名失效挂点——书键缓存随书生命周期正向失效（books.ts
 *  清理清单接线；TTL 5s 仍为兜底自愈）。 */
export function forgetStyleScanCache(bookRoot: string): void {
  styleScanCache.forget(bookRoot)
}
/** 导出供测试派生 sleep 时长——测试侧 5300 魔数与 TTL 双处
 * 硬编码，TTL 调大时「失效重扫」用例静默变假（仍在 TTL 内 → 断言 count=2 假红）。 */
export const STYLE_SCAN_TTL = 5000
/** 收尾：__styleScanCacheHasForTest / __setStyleScanTtlForTest 删除——
 * 缓存实例即观测面（生产对象，先例同 analysisOverviewCache）：has/TTL 覆盖档
 * （组装根 RouteOverrides 注入，随实例隔离）取代模块级钩子。 */
const STYLE_SCAN_MAX = 32

/** 缓存壳收编 ttl-cache.ts 通用件（原本地 Map + FIFO +
 * 过期逐出本地壳删除；命中/失效时序/逐出序逐位不变——纯 TTL + 异步计算 +
 * FIFO 32， ts 取写入当刻由通用件 store 统一承担，见其头部收敛映射表）。 */
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
}
