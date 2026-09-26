/**
 * 伏笔/线索追踪 REST 端点。
 *
 * GET /api/books/:name/foreshadows → 伏笔列表（结构化 fm + 足迹 + 风险）
 *
 * 数据源：设定/伏笔/*.md，front matter（标题/状态/埋设章号/回收章号/重要性/关联词）。
 * 足迹扫描由 document/foreshadow.ts 完成（本地正文 grep，零 AI）。
 * CRUD 复用 documents 端点（伏笔就是 md 文件）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { defineRoute } from './schema.js'
import { reply, replyError, parseRequestUrl } from '../http.js'
import { createTtlProbeCache } from '../ttl-cache.js'
import { resolveBookOrReply } from '../book-context.js'
import {
  readForeshadows,
  scanForeshadowTrails,
  scanForeshadowTrailsAsync,
  filterForeshadowTrails,
  type ForeshadowEntry,
  type ForeshadowTrail,
} from '../../../document/foreshadow.js'

interface ForeshadowCtx {
  workDir: string | null
  /** 收尾：伏笔足迹缓存 TTL 覆盖档——组装根 RouteOverrides 注入
 * （undefined = 生产口径 5s 逐位不变） */
  foreshadowTtlMs?: number | null
}

// ── 伏笔全书扫描「目录指纹 + TTL」缓存壳 ─────────────────
// 手法对齐 search.ts （目录 mtime 探针 + 纯 TTL + FIFO 上限 + 书键 forget 挂点）：
// 端点原每请求 readForeshadows（设定/伏笔 逐文件 fm 整读）+ scanForeshadowTrails
//（写作/正文 全书正文收集 + 联合正则扫），?q= 检索同样全量重扫后过滤——伏笔面板
// 打开/轮询/检索反复触发（章正文指纹缓存只省了逐文件重读，正则全书扫描与
// 伏笔 fm 整读每请求照付）。指纹覆盖被扫两目录（设定/伏笔 + 写作/正文）的 mtime：
// 新增/删除/改名即时失效；目录内就地内容改写不触碰目录 mtime，由 TTL 5s 兜底（与
// search.ts 同口径——宁多扫不脏读）。?q= 过滤在缓存命中后的快照上做（filter-
// ForeshadowTrails），不全量重扫。
// 原「扫描是同步单段、无在途去重需求」的判定随
// 异步化失效——端点改走 getForeshadowsCachedAsync（scanForeshadowTrailsAsync 切片
// 让出 + in-flight 去重，search.ts inFlightSearches 同款）；MISS 时并发请求只扫一次。
// 同步版 getForeshadowsCached 原样保留（回归测试直测面 + 行为规格参照）。
// 交付时只落了函数、handler 未随迁（收口声称失实，§七已
// 勘误）——handler 改 async 调 getForeshadowsCachedAsync，上述「端点改走 async」
// 自此真实生效。
const FORESHADOW_CACHE_TTL_MS = 5000
const FORESHADOW_CACHE_MAX = 32

/** 一次全书扫描的快照：伏笔条目 + 足迹（?q= 过滤与全量列表共用同一份）。 */
interface ForeshadowSnapshot {
  entries: ForeshadowEntry[]
  trails: Map<string, ForeshadowTrail>
}
/** 收尾：__setForeshadowCacheTtlForTest / __foreshadowScanCountForTest
 * （含 reset）删除——TTL 覆盖档改组装根 RouteOverrides 注入（getForeshadowsCached*
 * 覆盖尾参，随实例隔离）；MISS 计数收编进缓存壳（stats.misses），观测面 = 下方
 * 导出的缓存实例（生产对象，先例同 analysisOverviewCache）。 */
/** 删书/改名失效挂点（books.ts forgetBookKeyedCaches 家族同款）。 */
export function forgetForeshadowCache(bookRoot: string): void {
  foreshadowCache.forget(bookRoot)
}

/** 缓存壳收编 ttl-cache.ts 通用件（原本地 Map + FIFO +
 * 过期逐出 + foreshadowInFlight 在途去重表本地壳删除；命中/失效时序/逐出序
 * 逐位不变——单级探针 + FIFO 32 + in-flight 去重，同步/异步孪生共壳共 Map，
 * 见 ttl-cache.ts 头部收敛映射表）。 */
export const foreshadowCache = createTtlProbeCache<string, ForeshadowSnapshot>({
  name: 'foreshadows',
  keyOf: (k) => k,
  max: FORESHADOW_CACHE_MAX,
  ttl: () => FORESHADOW_CACHE_TTL_MS,
  probe: foreshadowDirSignature,
  computeSync: foreshadowComputeSync,
  computeAsync: foreshadowComputeAsync,
  inFlight: true,
})

/** 被扫目录全集的 mtime 签名（缺失计 '-'，先例同 search.ts dirSignature）：
 *  设定/伏笔（fm 读面）+ 写作/正文（足迹扫描面）。 */
function foreshadowDirSignature(bookRoot: string): string {
  const parts: string[] = []
  for (const dir of [join('设定', '伏笔'), join('写作', '正文')]) {
    try {
      parts.push(String(statSync(join(bookRoot, dir)).mtimeMs))
    } catch {
      parts.push('-') // 目录不存在
    }
  }
  return parts.join(',')
}

/** 同步孪生 MISS 计算体（回归测试直测面 + 行为规格参照）。 */
function foreshadowComputeSync(bookRoot: string): ForeshadowSnapshot {
  const entries = readForeshadows(bookRoot)
  const trails = scanForeshadowTrails(bookRoot, entries)
  return { entries, trails }
}

/** 异步孪生 MISS 计算体（生产路径）：scanForeshadowTrailsAsync 切片让出事件循环。 */
async function foreshadowComputeAsync(bookRoot: string): Promise<ForeshadowSnapshot> {
  const entries = readForeshadows(bookRoot)
  const trails = await scanForeshadowTrailsAsync(bookRoot, entries)
  return { entries, trails }
}

/** 伏笔条目 + 足迹快照（目录指纹 + TTL 缓存壳）。导出供回归测试直测。
 * 收尾：ttlOverrideMs = 逐调用 TTL 覆盖档（组装根 RouteOverrides 经
 * handler 传入；直测面显式传——undefined = 生产口径 5s）。 */
export function getForeshadowsCached(bookRoot: string, ttlOverrideMs?: number | null): ForeshadowSnapshot {
  return foreshadowCache.getSync(bookRoot, ttlOverrideMs ?? undefined)
}

/** 缓存壳的异步孪生$1端点生产路径）：命中语义与同步版逐位一致（同缓存
 *  同 TTL 同签名），MISS 时经 scanForeshadowTrailsAsync 切片让出事件循环（200 万字
 *  全书正则扫不再整段冻结请求线程），并以 in-flight 去重合并并发 MISS。 */
export function getForeshadowsCachedAsync(bookRoot: string, ttlOverrideMs?: number | null): Promise<ForeshadowSnapshot> {
  return foreshadowCache.get(bookRoot, undefined, ttlOverrideMs ?? undefined)
}

export function registerForeshadowRoutes(ctx: ForeshadowCtx): void {
  // 伏笔列表（fm 字段 + 正文足迹 + 风险评估）
  defineRoute('books.foreshadows', {
    method: 'GET',
    path: '/api/books/:name/foreshadows',
    // （评审）：本 handler 实际消费请求 URL（parseRequestUrl）——参数名去
    // `_` 前缀（本仓约定 `_` 前缀 = 未使用参数）；按位置传参，注册点无关，纯改名零行为。
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBookOrReply(ctx.workDir, params['name'], res)
    if (!r) return
    const bookRoot = r.bookRoot
    // ?q= 走伏笔足迹 FTS 检索（标题/关联词/命中片段）；缺省全量 + 足迹
    // parseRequestUrl 统一解析（/ 口径）——畸形 URL → 400 BAD_INPUT
    const url = parseRequestUrl(req)
    if (!url) return replyError(res, 400, 'BAD_INPUT', 'bad request')
    const q = url.searchParams.get('q') ?? undefined
    // 全量扫描走缓存壳；?q= 在快照上过滤（缓存命中不重扫）
    // 只交付了 getForeshadowsCachedAsync 函数，本 handler
    // 此前仍调同步版——「端点改走 async」的收口声称失实，随批补齐（异步切片让出 +
    // in-flight 去重自此真正上路；router dispatch 对 async handler 已有 catch 兜底）
    // 收尾：TTL 覆盖档经 ctx（组装根 RouteOverrides）逐调用传入
    const snapshot = await getForeshadowsCachedAsync(bookRoot, ctx.foreshadowTtlMs ?? undefined)
    if (q) {
      reply(res, 200, filterForeshadowTrails(snapshot.entries, snapshot.trails, q))
      return
    }
    const { entries, trails } = snapshot
    reply(res, 200, entries.map((e) => ({ ...e, 足迹: trails.get(e.标题) ?? null })))
  },
  })
}
