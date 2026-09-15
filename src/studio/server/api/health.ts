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
}

// 内存闸（2026-08-24 审计 D3）：scanChapters 每请求全书扫描（读全部定稿章 + 逐章算指纹），
// 体检页轮询/反复刷新会反复重扫。缓存口径对齐 overview.ts stateCache：5s TTL + 书键 Map
// FIFO 上限；overview 本身无写路径失效挂点（纯 TTL，概览页 stale 5s 可接受），此处同口径——
// 保存/定稿后最迟 5s 自愈，不做即时失效。
/** R67-15（十五轮）：删书/改名失效挂点——书键缓存随书生命周期正向失效（books.ts
 *  清理清单接线；TTL 5s 仍为兜底自愈）。 */
export function forgetStyleScanCache(bookRoot: string): void {
  styleScanCache.forget(bookRoot)
}
/** R67-15 回归观测钩子（先例同 stream.ts __getSseConnections）——删书清理接线测试
 *  经此断言缓存条目随 DELETE /api/books/:name 失效。仅测试用。 */
export function __styleScanCacheHasForTest(bookRoot: string): boolean {
  return styleScanCache.has(bookRoot)
}
/** R61-18（第六十一轮）：导出供测试派生 sleep 时长——测试侧 5300 魔数与 TTL 双处
 *  硬编码，TTL 调大时「失效重扫」用例静默变假（仍在 TTL 内 → 断言 count=2 假红）。 */
export const STYLE_SCAN_TTL = 5000
/** R62-21：TTL 测试注入口（先例同 __setReviewRunning）——d3-style-ttl 此前硬睡
 *  STYLE_SCAN_TTL+300 依赖真实 5.3s 墙钟，慢机假红；测试注入 300ms 档消除墙钟。
 *  传 null 恢复默认。仅测试用，勿在生产路径调用。 */
let styleScanTtlMs: number | null = null
export function __setStyleScanTtlForTest(ms: number | null): void {
  styleScanTtlMs = ms
}
const STYLE_SCAN_MAX = 32

/** D1（复审-0914-优化修复批）：缓存壳收编 ttl-cache.ts 通用件（原本地 Map + FIFO +
 *  R47-18 过期逐出本地壳删除；命中/失效时序/逐出序逐位不变——纯 TTL + 异步计算 +
 *  FIFO 32，R0912-B-P2-1 ts 取写入当刻由通用件 store 统一承担，见其头部收敛映射表）。 */
const styleScanCache = createTtlProbeCache<string, ChapterSample[]>({
  name: 'health-style-scan',
  keyOf: (k) => k,
  max: STYLE_SCAN_MAX,
  ttl: () => styleScanTtlMs ?? STYLE_SCAN_TTL,
  computeAsync: (bookRoot) => scanChaptersAsync(bookRoot),
})

/** 注册体检路由（server 启动时调用一次） */
export function registerHealthRoutes(ctx: HealthCtx): void {
  // 文风
  defineRoute('books.health.style', {
    method: 'GET',
    path: '/api/books/:name/health/style',
    handler: async ({ params }, _req, res) => {
    // SRV-N8（专项精简优化 §五，2026-09-15 机械批）：resolveBook 双行样板收编单源
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return
    const kind = readKind(r.bookRoot)
    // D3：命中短时缓存则跳过全书扫描（samples 为纯数据可复用；聚合与基线读取廉价，每次现算）
    // R40-4（四十轮）：miss 扫描切异步孪生——同步 scanChapters 在 200 万字大书上
    // 秒级冻结事件循环（R39-15 同族漏网点），逐 25 章让出对齐 analysis/learn 范式
    const samples = await styleScanCache.get(r.bookRoot)
    reply(res, 200, aggregateStyleTrend(samples, kind, readBaseline(r.bookRoot)))
  },
  })
}
