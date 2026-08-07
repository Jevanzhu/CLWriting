/**
 * 草稿/正文读取共享模块。
 *
 * 读正文区文件 → ChapterMeta + body，供 finalize/check/review/chat 共用。
 * 长篇 readChapter（章节 frontmatter 完整校验）；短篇 readPiece 映射 ChapterMeta（章号字段承载篇号）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { relative, join } from 'node:path'
import { readFile, splitFrontMatter, parseFlat } from './frontmatter.js'
import { readChapter, readChapterDir } from './chapters.js'
import { readPiece, readPieceDir } from './pieces.js'
import type { ChapterMeta } from './types.js'

export type ReadDraftResult =
  | { ok: true; chapter: ChapterMeta; body: string }
  | { ok: false; reason: string }

/**
 * 读正文区文件 → ChapterMeta + body。
 * - 长篇：readChapter（章节 front matter：章号/标题/钩子/情绪）
 * - 短篇：readPiece 映射 ChapterMeta（章号=篇号；目标情绪/核心反转带进 _raw）
 */
export function readDraft(draftPath: string, isShort: boolean): ReadDraftResult {
  if (!existsSync(draftPath)) {
    return { ok: false, reason: `找不到文件：${draftPath}` }
  }
  if (isShort) {
    const piece = readPiece(draftPath)
    if (!piece.ok) return { ok: false, reason: draftParseReason(piece.error.message, true) }
    const file = readFile(draftPath)
    if (!file.ok) return { ok: false, reason: draftParseReason(file.error.message, true) }
    const raw: Record<string, string> = { ...(piece.piece._raw ?? {}) }
    if (piece.piece.目标情绪) raw['目标情绪'] = piece.piece.目标情绪
    if (piece.piece.核心反转) raw['核心反转'] = piece.piece.核心反转
    const chapter: ChapterMeta = {
      章号: piece.piece.篇号,
      标题: piece.piece.标题,
      // 连续故事有真值则用真值，独立短篇 fallback dummy
      钩子类型: piece.piece.钩子类型 ?? '悬念钩',
      钩子强弱: piece.piece.钩子强弱 ?? '中',
      情绪定位: piece.piece.情绪定位 ?? '铺垫',
      ...(piece.piece.场景 ? { 场景: piece.piece.场景 } : {}),
      ...(piece.piece.字数目标 ? { 字数目标: piece.piece.字数目标 } : {}),
      ...(Object.keys(raw).length > 0 ? { _raw: raw } : {}),
      _path: piece.piece._path,
    }
    return { ok: true, chapter, body: file.body }
  }
  const chapter = readChapter(draftPath)
  if (!chapter.ok) return { ok: false, reason: draftParseReason(chapter.error.message, false) }
  const file = readFile(draftPath)
  if (!file.ok) return { ok: false, reason: draftParseReason(file.error.message, false) }
  return { ok: true, chapter: chapter.chapter, body: file.body }
}

/** 草稿 frontmatter 错误文案补全（长/短篇字段提示）。 */
export function draftParseReason(message: string, isShort: boolean): string {
  if (message.includes('front matter')) {
    if (isShort) {
      return `${message}。草稿必须以短篇 front matter 开头，至少包含：篇号、标题、目标情绪、核心反转。`
    }
    return `${message}。草稿必须以章节 front matter 开头，至少包含：章号、标题、钩子类型、钩子强弱、情绪定位。`
  }
  return message
}

/**
 * 定稿文件名规则（kind 分支）：
 * - long：写作/正文/<章号>-<标题>.md（扁平）
 * - short：写作/正文/<篇号3位>-<标题>.md（扁平，清单另放 大纲/清单/ 同名文件）
 */
export function finalChapterFileName(chapter: ChapterMeta, isShort: boolean): string {
  if (isShort) {
    return `${String(chapter.章号).padStart(3, '0')}-${chapter.标题}.md`
  }
  return `${chapter.章号}-${chapter.标题}.md`
}

// ── 正文区草稿路径定位（草稿目录取消后，草稿直接写正文区）──────────────

/**
 * 定位正文区草稿落盘路径（draft/final 同路径，靠 git 状态区分）。
 * - 已有同章号文件 → 覆盖写（返回该路径）
 * - 新章 → 从 content frontmatter 解析标题，推断卷目录，生成正式文件路径
 */
export function resolveDraftPath(
  bookRoot: string,
  chapter: number,
  kind: 'long' | 'short',
  content?: string,
): { relPath: string; existed: boolean } {
  const isShort = kind === 'short'
  const bodyDir = join(bookRoot, '写作', '正文')

  // 1. 已有同章号 → 覆盖
  if (existsSync(bodyDir)) {
    if (isShort) {
      const hit = readPieceDir(bodyDir).pieces.find((p) => p.篇号 === chapter)
      if (hit?._path) return { relPath: slashRelative(bookRoot, hit._path), existed: true }
    } else {
      const hit = readChapterDir(bodyDir).chapters.find((c) => c.章号 === chapter)
      if (hit?._path) return { relPath: slashRelative(bookRoot, hit._path), existed: true }
    }
  }

  // 2. 新章 → 生成正式文件路径
  const title = extractTitleFromContent(content) ?? (isShort ? `第${chapter}篇` : `第${chapter}章`)
  const fileName = isShort
    ? `${String(chapter).padStart(3, '0')}-${title}.md`
    : `${chapter}-${title}.md`
  if (isShort) return { relPath: `写作/正文/${fileName}`, existed: false }

  // 长篇：推断卷目录（上一章所在卷 > 最新卷 > 第一卷）
  return { relPath: `写作/正文/${inferVolumeDir(bookRoot, chapter)}/${fileName}`, existed: false }
}

/** 从 content frontmatter 提取标题（无 frontmatter/无标题 → null）。 */
function extractTitleFromContent(content?: string): string | null {
  if (!content) return null
  const split = splitFrontMatter(content)
  if (!split) return null
  const title = parseFlat(split.fmRaw).get('标题')
  return typeof title === 'string' && title.trim() ? title.trim() : null
}

/** 长篇卷目录推断：上一章卷 > 最新卷 > 第一卷。 */
function inferVolumeDir(bookRoot: string, chapter: number): string {
  const bodyDir = join(bookRoot, '写作', '正文')
  if (existsSync(bodyDir)) {
    const { chapters } = readChapterDir(bodyDir)
    const prev = chapters.find((c) => c.章号 === chapter - 1)
    if (prev?._path) {
      const seg = slashRelative(bodyDir, prev._path).split('/')[0]
      if (seg && !seg.endsWith('.md')) return seg
    }
    const vols = readdirSync(bodyDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    if (vols.length > 0) return vols[vols.length - 1]!
  }
  return '第一卷'
}

/** 绝对路径 → 正斜杠相对路径（跨平台）。 */
function slashRelative(base: string, absPath: string): string {
  return relative(base, absPath).replace(/\\/g, '/')
}
