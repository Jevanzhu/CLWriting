/**
 * 书架进度摘要共享（overview 单书 + books 书架列表共用）。
 *
 * - computeProgress：正文章数+字数（长短统一 readChapterDir）
 * - computeBookSummary：进度 + 最近编辑 + 最新章节一次扫描算出（书架卡）。
 *
 * 从 overview.ts 提取（P2 书架充实：books 端点补摘要需复用，避免 DRY）。
 * X-24（第五十六轮）：删除三个零引用导出（computeLastEdited / computeLatestChapter /
 * finalizedFiles——独立扫描版早被 computeBookSummary 取代，已 grep 复核零引用）。
 */
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { readChapterDir } from '../../../format/chapters.js'

/** 进度：正文章数+字数（长短统一）。 */
export function computeProgress(bookRoot: string): { chapters: number; words: number } {
  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
  const words = chapters.reduce((sum, c) => sum + (c._wordCount ?? 0), 0)
  return { chapters: chapters.length, words }
}

/**
 * 书架摘要（一次 readChapterDir 扫描算出进度 + 最近编辑 + 最新章节）。
 * 替代 computeProgress + computeLastEdited + computeLatestChapter 三次独立扫描（P2-BE-1）。
 */
export function computeBookSummary(bookRoot: string): {
  chapters: number
  words: number
  lastEdited: string | null
  latestChapter: string | null
} {
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

/** V-P2-27：保存成功后失效该书摘要（书架卡即时反映新字数，不等 TTL）。 */
export function invalidateBookSummary(bookRoot: string): void {
  summaryCache.delete(bookRoot)
}

/** V-P2-27：摘要 TTL 缓存——GET /api/books 对每本书同步整树扫描（读全部章节文件），
 *  书多时阻塞事件循环拖慢书架与 SSE 心跳。书架卡允许秒级滞后，缓存 5s；
 *  内存上限防长期运行的书库累积。 */
const SUMMARY_TTL_MS = 5000
const SUMMARY_CACHE_MAX = 64
const summaryCache = new Map<string, { at: number; value: ReturnType<typeof computeBookSummaryUncached> }>()

function computeBookSummaryUncached(bookRoot: string): {
  chapters: number
  words: number
  lastEdited: string | null
  latestChapter: string | null
} {
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
