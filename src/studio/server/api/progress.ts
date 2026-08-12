/**
 * 书架进度摘要共享（overview 单书 + books 书架列表共用）。
 *
 * - computeProgress：正文章数+字数（长短统一 readChapterDir）
 * - computeLastEdited：定稿文件最新 mtime（书架卡「最近编辑」用）。
 *
 * 从 overview.ts 提取（P2 书架充实：books 端点补摘要需复用，避免 DRY）。
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

/** 定稿文件列表（写作/正文，长短同一）。读取失败返回空（调用方降级）。 */
function finalizedFiles(bookRoot: string): string[] {
  try {
    const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
    return chapters.filter((c) => c._path).map((c) => c._path!)
  } catch {
    return []
  }
}

/** 最近编辑：定稿文件最新 mtime（ISO 字符串）；无定稿返回 null。 */
export function computeLastEdited(bookRoot: string): string | null {
  const files = finalizedFiles(bookRoot)
  let latest = 0
  for (const fp of files) {
    try {
      const m = statSync(fp).mtimeMs
      if (m > latest) latest = m
    } catch {
      // 文件消失忽略
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : null
}

/** 最近章节标题：按已定稿文件 mtime 最新取其标题（hero 卡"继续写作"用）；无定稿返回 null */
export function computeLatestChapter(bookRoot: string): string | null {
  const items = readChapterDir(join(bookRoot, '写作', '正文')).chapters
  let latest: { title: string; mtime: number } | null = null
  for (const it of items) {
    if (!it._path) continue
    try {
      const m = statSync(it._path).mtimeMs
      if (!latest || m > latest.mtime) latest = { title: it.标题, mtime: m }
    } catch {
      // 文件消失忽略
    }
  }
  return latest?.title ?? null
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
