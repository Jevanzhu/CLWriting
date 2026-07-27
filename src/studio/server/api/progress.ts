/**
 * 书架进度摘要共享（overview 单书 + books 书架列表共用）。
 *
 * - computeProgress：长篇=定稿正文章数+字数；短篇=篇/ 目录数。
 * - computeLastEdited：定稿文件最新 mtime（书架卡「最近编辑」用）。
 *
 * 从 overview.ts 提取（P2 书架充实：books 端点补摘要需复用，避免 DRY）。
 */
import { join } from 'node:path'
import { readdirSync, existsSync, statSync } from 'node:fs'
import { readChapterDir } from '../../../format/chapters.js'
import { readPieceDir } from '../../../format/pieces.js'

/** 进度：长篇=定稿正文章数+字数；短篇=篇/ 目录数。 */
export function computeProgress(bookRoot: string, kind: 'long' | 'short'): { chapters: number; words: number } {
  if (kind === 'short') {
    const piecesDir = join(bookRoot, '篇')
    if (!existsSync(piecesDir)) return { chapters: 0, words: 0 }
    let n = 0
    try {
      n = readdirSync(piecesDir).filter((x) => !x.startsWith('.')).length
    } catch {
      // 无篇目录
    }
    return { chapters: n, words: 0 }
  }
  const { chapters } = readChapterDir(join(bookRoot, '定稿', '正文'))
  const words = chapters.reduce((sum, c) => sum + (c._wordCount ?? 0), 0)
  return { chapters: chapters.length, words }
}

/** 定稿文件列表（长篇 定稿/正文，短篇 篇/）。读取失败返回空（调用方降级）。 */
function finalizedFiles(bookRoot: string, kind: 'long' | 'short'): string[] {
  if (kind === 'short') {
    try {
      const { pieces } = readPieceDir(join(bookRoot, '篇'))
      return pieces.filter((p) => p._path).map((p) => p._path!)
    } catch {
      return []
    }
  }
  try {
    const { chapters } = readChapterDir(join(bookRoot, '定稿', '正文'))
    return chapters.filter((c) => c._path).map((c) => c._path!)
  } catch {
    return []
  }
}

/** 最近编辑：定稿文件最新 mtime（ISO 字符串）；无定稿返回 null。 */
export function computeLastEdited(bookRoot: string, kind: 'long' | 'short'): string | null {
  const files = finalizedFiles(bookRoot, kind)
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

/** 最近章节/篇标题：按定稿文件 mtime 最新取其标题（hero 卡"继续写作"用）；无定稿返回 null */
export function computeLatestChapter(bookRoot: string, kind: 'long' | 'short'): string | null {
  const items =
    kind === 'short'
      ? readPieceDir(join(bookRoot, '篇')).pieces
      : readChapterDir(join(bookRoot, '定稿', '正文')).chapters
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
