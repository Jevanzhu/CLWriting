/**
 * 搜索端点（§19.1，W2A 收尾）：全书 .md 扫描，YAGNI 不引 FTS。
 *
 * GET /api/books/:name/search?q=&scope=all|定稿|设定|大纲|工作区
 *   → { results: [{path, matches: [{line, text}]}], truncated? }
 *
 * 实现已下沉 src/process/book-search.ts（对话助手 book_search 工具共用，
 * 不复制逻辑）；本文件只做 HTTP 壳。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { defineRoute } from './schema.js'
import { reply, replyError, parseRequestUrl } from '../http.js'
import { resolveBook } from '../book-context.js'
import { searchBookAsync, SEARCH_ALL_DIRS, type SearchOutcome } from '../../../process/book-search.js'

interface SearchCtx {
  workDir: string | null
}

// ── R35-7（三十五轮）：全书扫描短 TTL 缓存 + 在途去重 ─────────────────────────
// 手法对齐 knowledge.ts learnCache / progress.ts summaryCache（书键 Map + FIFO 上限 +
// 纯 TTL；删书/改名经 books.ts forgetBookKeyedCaches 失效）。R35-7 async 化后扫描不再
// 冻结事件循环，但查询词稀有时仍须读完全部文件才返回——重复点击/同参数并发去重为一次
// 扫描。失效口径在纯 TTL 之上加目录 mtime 结构探针（方案偏离记档）：既有 V-P2-25 契约
// 要求「写完即搜可见」（直写盘的文件服务端无写事件可挂），探针让新增/删除/改名等目录
// 结构变化即时失效缓存，TTL 5s 只兜内容改写（不触碰目录 mtime）的最坏可见窗。
const SEARCH_CACHE_TTL_MS = 5000
const SEARCH_CACHE_MAX = 32
const searchCache = new Map<string, { outcome: SearchOutcome; ts: number; sig: string }>()
const inFlightSearches = new Map<string, Promise<SearchOutcome>>()

/** 可搜目录全集的 mtime 签名（缺失计 '-'）：每次命中前重算，5 次 stat 换免整书重扫。
 *  必须在扫描**前**取值——扫描期间落盘的变更会使签名失配，下次按失效重扫（宁多扫不脏读）。 */
function dirSignature(bookRoot: string): string {
  const parts: string[] = []
  for (const dir of SEARCH_ALL_DIRS) {
    try {
      parts.push(String(statSync(join(bookRoot, dir)).mtimeMs))
    } catch {
      parts.push('-') // 目录不存在
    }
  }
  return parts.join(',')
}

let searchTtlMs: number | null = null
/** TTL 测试注入口（null 还原默认；先例同 knowledge.ts __setLearnTtlForTest）。 */
export function __setSearchCacheTtlForTest(ms: number | null): void {
  searchTtlMs = ms
}

/** R35-7：删书/改名失效挂点（同 forgetLearnCache 口径；在途扫描不取消，结果照常落缓存）。 */
export function forgetSearchCache(bookRoot: string): void {
  for (const key of searchCache.keys()) {
    if (key.startsWith(bookRoot + '\u0000')) searchCache.delete(key)
  }
}

/** R35-7：底层实际扫描计数观察口（验证缓存命中/在途去重；生产零调用）。 */
let scanCountForTest = 0
export function __searchScanCountForTest(): number {
  return scanCountForTest
}
export function __resetSearchScanCountForTest(): void {
  scanCountForTest = 0
}

function cacheKey(bookRoot: string, q: string, scope: string | undefined): string {
  return `${bookRoot}\u0000${scope ?? ''}\u0000${q}`
}

/** 全书搜索（缓存 + 在途去重 + 底层 searchBookAsync）。导出供回归测试直测。 */
export async function searchBookCached(bookRoot: string, q: string, scope?: string): Promise<SearchOutcome> {
  const query = (q ?? '').trim()
  if (!query) return { results: [] } // 空查询零成本直返，不占缓存
  const key = cacheKey(bookRoot, query, scope)
  const sig = dirSignature(bookRoot)
  const cached = searchCache.get(key)
  if (cached && cached.sig === sig && Date.now() - cached.ts < (searchTtlMs ?? SEARCH_CACHE_TTL_MS)) {
    return cached.outcome
  }
  const inFlight = inFlightSearches.get(key)
  if (inFlight) return inFlight // 在途去重：同参数并发只跑一次
  scanCountForTest += 1
  const p = searchBookAsync(bookRoot, query, scope)
    .then((outcome) => {
      // 简单 FIFO 淘汰（Map 保插入序）：超上限丢最旧条目，防长期运行的书库累积
      if (searchCache.size >= SEARCH_CACHE_MAX) {
        const oldest = searchCache.keys().next().value
        if (oldest !== undefined) searchCache.delete(oldest)
      }
      searchCache.set(key, { outcome, ts: Date.now(), sig })
      return outcome
    })
    .finally(() => {
      inFlightSearches.delete(key)
    })
  inFlightSearches.set(key, p)
  return p
}

export function registerSearchRoutes(ctx: SearchCtx): void {
  defineRoute('books.search', {
    method: 'GET',
    path: '/api/books/:name/search',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)

    // Y-10（第五十七轮）：R-19 parseRequestUrl 收编漏网点——畸形请求行 400 BAD_INPUT
    //（此前 api 层唯一残留的裸 new URL，属口径漂移死分叉）
    const url = parseRequestUrl(req)
    if (!url) return replyError(res, 400, 'BAD_INPUT', 'bad request')
    const q = (url.searchParams.get('q') ?? '').trim()
    const scope = url.searchParams.get('scope') ?? undefined

    // R35-7：异步扫描 + 缓存/去重（原同步 searchBook 冻结事件循环，见上方块注）
    const out = await searchBookCached(r.bookRoot, q, scope)
    if (out.truncated) reply(res, 200, { results: out.results, truncated: true })
    else reply(res, 200, { results: out.results })
  },
  })
}
