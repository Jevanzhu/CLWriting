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
// ForeshadowTrails），不全量重扫。扫描是同步单段（无在途并发窗口），去重不存在
// searchBookAsync 那样的在途去重需求，缓存壳取 getVersionStatsCached 同款同步形态。
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

export function registerForeshadowRoutes(ctx: ForeshadowCtx): void {
  // 伏笔列表（fm 字段 + 正文足迹 + 风险评估）
  defineRoute('books.foreshadows', {
    method: 'GET',
    path: '/api/books/:name/foreshadows',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const bookRoot = r.bookRoot
    // F1-P3：?q= 走伏笔足迹 FTS 检索（标题/关联词/命中片段）；缺省全量 + 足迹
    // R-19（第十六轮）：parseRequestUrl 统一解析（Q-1/N-3 口径）——畸形 URL → 400 BAD_INPUT
    const url = parseRequestUrl(_req)
    if (!url) return replyError(res, 400, 'BAD_INPUT', 'bad request')
    const q = url.searchParams.get('q') ?? undefined
    // R44-8：全量扫描走缓存壳；?q= 在快照上过滤（缓存命中不重扫）
    const snapshot = getForeshadowsCached(bookRoot)
    if (q) {
      reply(res, 200, filterForeshadowTrails(snapshot.entries, snapshot.trails, q))
      return
    }
    const { entries, trails } = snapshot
    reply(res, 200, entries.map((e) => ({ ...e, 足迹: trails.get(e.标题) ?? null })))
  },
  })
}
