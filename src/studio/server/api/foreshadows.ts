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
import { resolveBook } from '../book-context.js'
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
}

// ── R44-8（四十四轮）：伏笔全书扫描「目录指纹 + TTL」缓存壳 ─────────────────
// 手法对齐 search.ts R35-7（目录 mtime 探针 + 纯 TTL + FIFO 上限 + 书键 forget 挂点）：
// 端点原每请求 readForeshadows（设定/伏笔 逐文件 fm 整读）+ scanForeshadowTrails
//（写作/正文 全书正文收集 + 联合正则扫），?q= 检索同样全量重扫后过滤——伏笔面板
// 打开/轮询/检索反复触发（R66-6 章正文指纹缓存只省了逐文件重读，正则全书扫描与
// 伏笔 fm 整读每请求照付）。指纹覆盖被扫两目录（设定/伏笔 + 写作/正文）的 mtime：
// 新增/删除/改名即时失效；目录内就地内容改写不触碰目录 mtime，由 TTL 5s 兜底（与
// search.ts 同口径——宁多扫不脏读）。?q= 过滤在缓存命中后的快照上做（filter-
// ForeshadowTrails），不全量重扫。
// PM-1（性能与内存专项·2026-09-05）：原「扫描是同步单段、无在途去重需求」的判定随
// 异步化失效——端点改走 getForeshadowsCachedAsync（scanForeshadowTrailsAsync 切片
// 让出 + in-flight 去重，search.ts inFlightSearches 同款）；MISS 时并发请求只扫一次。
// 同步版 getForeshadowsCached 原样保留（回归测试直测面 + 行为规格参照）。
// R48-19（四十八轮）：PM-1 交付时只落了函数、handler 未随迁（收口声称失实，§七已
// 勘误）——handler 改 async 调 getForeshadowsCachedAsync，上述「端点改走 async」
// 自此真实生效。
const FORESHADOW_CACHE_TTL_MS = 5000
const FORESHADOW_CACHE_MAX = 32

/** 一次全书扫描的快照：伏笔条目 + 足迹（?q= 过滤与全量列表共用同一份）。 */
export interface ForeshadowSnapshot {
  entries: ForeshadowEntry[]
  trails: Map<string, ForeshadowTrail>
}
const foreshadowCache = new Map<string, { snapshot: ForeshadowSnapshot; ts: number; sig: string }>()
let foreshadowTtlMs: number | null = null
/** R44-8：TTL 测试注入口（先例同 __setSearchCacheTtlForTest）。仅测试用。 */
export function __setForeshadowCacheTtlForTest(ms: number | null): void {
  foreshadowTtlMs = ms
}
/** R44-8：删书/改名失效挂点（books.ts forgetBookKeyedCaches 家族同款）。 */
export function forgetForeshadowCache(bookRoot: string): void {
  foreshadowCache.delete(bookRoot)
}
/** R44-8 回归观测钩子（生产零调用；先例同 __searchScanCountForTest）：缓存 MISS →
 *  全量重扫（readForeshadows + scanForeshadowTrails）计数。 */
let foreshadowScanCount = 0
export function __foreshadowScanCountForTest(): number {
  return foreshadowScanCount
}
export function __resetForeshadowScanCountForTest(): void {
  foreshadowScanCount = 0
}

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

/** R44-8：伏笔条目 + 足迹快照（目录指纹 + TTL 缓存壳）。导出供回归测试直测。 */
export function getForeshadowsCached(bookRoot: string): ForeshadowSnapshot {
  const sig = foreshadowDirSignature(bookRoot)
  const cached = foreshadowCache.get(bookRoot)
  if (cached && cached.sig === sig && Date.now() - cached.ts < (foreshadowTtlMs ?? FORESHADOW_CACHE_TTL_MS)) {
    return cached.snapshot
  }
  // R47-18（四十七轮）：过期条目顺手逐出——原只当 miss 用、条目驻留至 FIFO 触顶/删书
  //（forgetForeshadowCache）；重算路径本就必走且 set 原键覆写，零成本零语义变更。sig
  // 失配但未过期的条目不在此次清（本函数同步单段，下方 set 必覆写同键）
  if (cached && Date.now() - cached.ts >= (foreshadowTtlMs ?? FORESHADOW_CACHE_TTL_MS)) foreshadowCache.delete(bookRoot)
  foreshadowScanCount += 1
  const entries = readForeshadows(bookRoot)
  const trails = scanForeshadowTrails(bookRoot, entries)
  const snapshot: ForeshadowSnapshot = { entries, trails }
  // 简单 FIFO 淘汰（Map 保插入序）：超上限丢最旧条目，防长期运行的书库累积
  if (foreshadowCache.size >= FORESHADOW_CACHE_MAX) {
    const oldest = foreshadowCache.keys().next().value
    if (oldest !== undefined) foreshadowCache.delete(oldest)
  }
  foreshadowCache.set(bookRoot, { snapshot, ts: Date.now(), sig })
  return snapshot
}

/** PM-1：in-flight 去重表（search.ts inFlightSearches 同款）——同书并发 MISS 只扫一次，
 *  后到者 await 同一 Promise；job 收尾（成功或失败）自清。 */
const foreshadowInFlight = new Map<string, Promise<ForeshadowSnapshot>>()

/** R44-8 缓存壳的异步孪生（PM-1，端点生产路径）：命中语义与同步版逐位一致（同缓存
 *  同 TTL 同签名），MISS 时经 scanForeshadowTrailsAsync 切片让出事件循环（200 万字
 *  全书正则扫不再整段冻结请求线程），并以 in-flight 去重合并并发 MISS。 */
export function getForeshadowsCachedAsync(bookRoot: string): Promise<ForeshadowSnapshot> {
  const sig = foreshadowDirSignature(bookRoot)
  const cached = foreshadowCache.get(bookRoot)
  if (cached && cached.sig === sig && Date.now() - cached.ts < (foreshadowTtlMs ?? FORESHADOW_CACHE_TTL_MS)) {
    return Promise.resolve(cached.snapshot)
  }
  // R47-18 过期逐出口径同步版同款：过期条目先清（异步扫描窗口长，驻留无意义）；sig
  // 失配未过期的条目留给扫描完成后的 set 原键覆写
  if (cached && Date.now() - cached.ts >= (foreshadowTtlMs ?? FORESHADOW_CACHE_TTL_MS)) foreshadowCache.delete(bookRoot)
  const inFlight = foreshadowInFlight.get(bookRoot)
  if (inFlight) return inFlight
  const job = (async (): Promise<ForeshadowSnapshot> => {
    foreshadowScanCount += 1
    const entries = readForeshadows(bookRoot)
    const trails = await scanForeshadowTrailsAsync(bookRoot, entries)
    const snapshot: ForeshadowSnapshot = { entries, trails }
    // FIFO 淘汰与同步版同款（Map 保插入序）
    if (foreshadowCache.size >= FORESHADOW_CACHE_MAX) {
      const oldest = foreshadowCache.keys().next().value
      if (oldest !== undefined) foreshadowCache.delete(oldest)
    }
    foreshadowCache.set(bookRoot, { snapshot, ts: Date.now(), sig })
    return snapshot
  })()
  foreshadowInFlight.set(bookRoot, job)
  // 收尾自清（catch 先落避免 job 被拒时清理链 unhandled rejection；原 job 的拒绝仍
  // 按常送达真实调用方——路由层有统一错误面）
  job.catch(() => {}).then(() => foreshadowInFlight.delete(bookRoot))
  return job
}

export function registerForeshadowRoutes(ctx: ForeshadowCtx): void {
  // 伏笔列表（fm 字段 + 正文足迹 + 风险评估）
  defineRoute('books.foreshadows', {
    method: 'GET',
    path: '/api/books/:name/foreshadows',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const bookRoot = r.bookRoot
    // F1-P3：?q= 走伏笔足迹 FTS 检索（标题/关联词/命中片段）；缺省全量 + 足迹
    // R-19（第十六轮）：parseRequestUrl 统一解析（Q-1/N-3 口径）——畸形 URL → 400 BAD_INPUT
    const url = parseRequestUrl(_req)
    if (!url) return replyError(res, 400, 'BAD_INPUT', 'bad request')
    const q = url.searchParams.get('q') ?? undefined
    // R44-8：全量扫描走缓存壳；?q= 在快照上过滤（缓存命中不重扫）
    // R48-19（四十八轮）：PM-1 只交付了 getForeshadowsCachedAsync 函数，本 handler
    // 此前仍调同步版——「端点改走 async」的收口声称失实，随批补齐（异步切片让出 +
    // in-flight 去重自此真正上路；router dispatch 对 async handler 已有 catch 兜底）
    const snapshot = await getForeshadowsCachedAsync(bookRoot)
    if (q) {
      reply(res, 200, filterForeshadowTrails(snapshot.entries, snapshot.trails, q))
      return
    }
    const { entries, trails } = snapshot
    reply(res, 200, entries.map((e) => ({ ...e, 足迹: trails.get(e.标题) ?? null })))
  },
  })
}
