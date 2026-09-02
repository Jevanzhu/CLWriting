/**
 * 书架进度摘要共享（overview 单书 + books 书架列表共用）。
 *
 * - computeProgress：正文章数+字数（长短统一 readChapterDir）
 * - computeBookSummary：进度 + 最近编辑 + 最新章节一次扫描算出（书架卡）。
 *
 * 从 overview.ts 提取（P2 书架充实：books 端点补摘要需复用，避免 DRY）。
 * X-24（第五十六轮）：删除三个零引用导出（computeLastEdited / computeLatestChapter /
 * finalizedFiles——独立扫描版早被 computeBookSummary 取代，已 grep 复核零引用）。
 * R37-3（三十七轮）：api 层全书扫描的异步让出原语与 async 孪生落此共享（overview.ts
 * 的 computeTimeline / books.ts 书架循环同源引用）。
 */
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { readChapterDir } from '../../../format/chapters.js'

// ── R37-3（三十七轮）：服务热路径全书扫描的逐块让出 ──────────────────────
// 服务是 Electron 主进程内嵌的单进程 HTTP 服务，同步全书扫描在大书上单请求冻结事件
// 循环 = 桌面整体卡死。让出范式同 learn/index.ts R72-2 与 src/check/run.ts R37-3
//（setImmediate 级，块与块之间其它请求/SSE 心跳可跑）；粒度统一每 25 章/条。
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
/** R37-3：逐块让出粒度——每处理 25 章/条让出一次（与 check/run.ts TREE_ISSUES_YIELD_EVERY 同口径）。 */
export const SCAN_YIELD_EVERY = 25

/** 进度：正文章数+字数（长短统一）。 */
export function computeProgress(bookRoot: string): { chapters: number; words: number } {
  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
  const words = chapters.reduce((sum, c) => sum + (c._wordCount ?? 0), 0)
  return { chapters: chapters.length, words }
}

/**
 * R37-3（三十七轮）：computeProgress 的 async 孪生（overview 端点改走此路径）。
 * 边界如实记：本函数主体是单段 readChapterDir（内核 src/format/chapters.ts 不在本批
 * 允许清单，无法在其内部切分）——其热路径有 stat 级元数据缓存（CC-P1-3：未变章只
 * stat 不整读），冷路径（首次/有章变更）单章重读仍属该同步段；此处让出点在扫描段
 * 与归并段之间，保证端点 handler 不再是「无让出的整段同步链」。结果与同步版逐位
 * 一致（r37 回归锚守护）。
 */
export async function computeProgressAsync(bookRoot: string): Promise<{ chapters: number; words: number }> {
  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
  await yieldToEventLoop()
  const words = chapters.reduce((sum, c) => sum + (c._wordCount ?? 0), 0)
  return { chapters: chapters.length, words }
}

/**
 * 书架摘要（一次 readChapterDir 扫描算出进度 + 最近编辑 + 最新章节）。
 * 替代 computeProgress + computeLastEdited + computeLatestChapter 三次独立扫描（P2-BE-1）。
 */
export function computeBookSummary(bookRoot: string): BookSummary {
  const cached = summaryCache.get(bookRoot)
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.value
  const value = computeBookSummaryUncached(bookRoot)
  // 简单 FIFO 淘汰（Map 保插入序）：超上限丢最旧条目
  if (summaryCache.size >= SUMMARY_CACHE_MAX) {
    const oldest = summaryCache.keys().next().value
    if (oldest !== undefined) summaryCache.delete(oldest)
  }
  summaryCache.set(bookRoot, { at: Date.now(), value })
  return value
}

/** R37-3：书架摘要结果形状（同步/async 孪生共用）。 */
export interface BookSummary {
  chapters: number
  words: number
  lastEdited: string | null
  latestChapter: string | null
}

/**
 * R37-3（三十七轮）：computeBookSummary 的 async 孪生——books 书架列表端点逐书改走
 * 此路径（缓存命中口径与同步版一致：5s TTL + FIFO + invalidateBookSummary 失效挂点
 * 共享同一 summaryCache，双版本互通）。未命中路径的 mtime 扫描循环每 SCAN_YIELD_EVERY
 * 章让出一次；readChapterDir 扫描段边界同 computeProgressAsync 头注。结果与同步版
 * 逐位一致（r37 回归锚守护）。
 */
export async function computeBookSummaryAsync(bookRoot: string): Promise<BookSummary> {
  const cached = summaryCache.get(bookRoot)
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.value
  const value = await computeBookSummaryUncachedAsync(bookRoot)
  if (summaryCache.size >= SUMMARY_CACHE_MAX) {
    const oldest = summaryCache.keys().next().value
    if (oldest !== undefined) summaryCache.delete(oldest)
  }
  summaryCache.set(bookRoot, { at: Date.now(), value })
  return value
}

/** V-P2-27：保存成功后失效该书摘要（书架卡即时反映新字数，不等 TTL）。 */
export function invalidateBookSummary(bookRoot: string): void {
  summaryCache.delete(bookRoot)
}

/** V-P2-27：摘要 TTL 缓存——GET /api/books 对每本书同步整树扫描（读全部章节文件），
 *  书多时阻塞事件循环拖慢书架与 SSE 心跳。书架卡允许秒级滞后，缓存 5s；
 *  内存上限防长期运行的书库累积。 */
const SUMMARY_TTL_MS = 5000
const SUMMARY_CACHE_MAX = 64
const summaryCache = new Map<string, { at: number; value: BookSummary }>()

function computeBookSummaryUncached(bookRoot: string): BookSummary {
  let items: ReturnType<typeof readChapterDir>['chapters']
  try {
    items = readChapterDir(join(bookRoot, '写作', '正文')).chapters
  } catch {
    return { chapters: 0, words: 0, lastEdited: null, latestChapter: null }
  }
  const words = items.reduce((sum, c) => sum + (c._wordCount ?? 0), 0)
  let latestMtime = 0
  let latestTitle: string | null = null
  for (const it of items) {
    if (!it._path) continue
    try {
      const m = statSync(it._path).mtimeMs
      if (m > latestMtime) {
        latestMtime = m
        latestTitle = it.标题
      }
    } catch {
      // 文件消失忽略
    }
  }
  return {
    chapters: items.length,
    words,
    lastEdited: latestMtime > 0 ? new Date(latestMtime).toISOString() : null,
    latestChapter: latestTitle,
  }
}

/** R37-3：computeBookSummaryUncached 的逐块让出版（循环体与同步版逐位一致 + 每 25 章让出）。 */
async function computeBookSummaryUncachedAsync(bookRoot: string): Promise<BookSummary> {
  let items: ReturnType<typeof readChapterDir>['chapters']
  try {
    items = readChapterDir(join(bookRoot, '写作', '正文')).chapters
  } catch {
    return { chapters: 0, words: 0, lastEdited: null, latestChapter: null }
  }
  const words = items.reduce((sum, c) => sum + (c._wordCount ?? 0), 0)
  let latestMtime = 0
  let latestTitle: string | null = null
  let processed = 0
  for (const it of items) {
    if (!it._path) continue
    // R37-3：悬停点——mtime 扫描循环每 SCAN_YIELD_EVERY 章让出一次
    if (++processed % SCAN_YIELD_EVERY === 0) await yieldToEventLoop()
    try {
      const m = statSync(it._path).mtimeMs
      if (m > latestMtime) {
        latestMtime = m
        latestTitle = it.标题
      }
    } catch {
      // 文件消失忽略
    }
  }
  return {
    chapters: items.length,
    words,
    lastEdited: latestMtime > 0 ? new Date(latestMtime).toISOString() : null,
    latestChapter: latestTitle,
  }
}
