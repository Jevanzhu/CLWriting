/**
 * 草稿读取共享模块（W2B B2.0）。
 *
 * 原 cli/finalize.ts + cli/check.ts + cli/review.ts 三份重复 readDraft 合并到此。
 * 读 工作区/草稿-N.md → ChapterMeta + body，供 finalize/check/review/hand 共用。
 * 长篇 readChapter（章节 frontmatter 完整校验）；短篇 readPiece 映射 ChapterMeta（章号字段承载篇号）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { readFile } from './frontmatter.js'
import { readChapter } from './chapters.js'
import { readPiece } from './pieces.js'
import type { ChapterMeta } from './types.js'

export type ReadDraftResult =
  | { ok: true; chapter: ChapterMeta; body: string }
  | { ok: false; reason: string }

/**
 * 读草稿（工作区/草稿-N.md）→ ChapterMeta + body。
 * - 长篇：readChapter（章节 front matter：章号/标题/钩子/情绪）
 * - 短篇：readPiece 映射 ChapterMeta（章号=篇号；目标情绪/核心反转带进 _raw）
 */
export function readDraft(draftPath: string, isShort: boolean): ReadDraftResult {
  if (!existsSync(draftPath)) {
    return { ok: false, reason: missingDraftReason(draftPath) }
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
      钩子类型: '悬念钩',
      钩子强弱: '中',
      情绪定位: '铺垫',
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

/** 草稿缺失文案（默认 草稿-1.md 时提示候选序号语义）。 */
export function missingDraftReason(draftPath: string): string {
  const dir = dirname(draftPath)
  let candidates: string[] = []
  try {
    candidates = readdirSync(dir).filter((f) => /^草稿-\d+\.md$/.test(f))
  } catch {
    // ignore
  }
  if (draftPath.endsWith('草稿-1.md') && candidates.length > 0) {
    return `找不到默认草稿-1.md。草稿-N 的 N 是候选序号，不是章号；请把当前候选写为 草稿-1.md，或显式传入草稿路径。当前有：${candidates.join('、')}`
  }
  return `找不到草稿文件：${draftPath}`
}

/**
 * 定稿文件名规则（kind 分支）：
 * - long：定稿/正文/<章号>-<标题>.md（扁平）
 * - short：篇/<篇号3位>-<标题>/正文.md（子路径）
 */
export function finalChapterFileName(chapter: ChapterMeta, isShort: boolean): string {
  if (isShort) {
    return `${String(chapter.章号).padStart(3, '0')}-${chapter.标题}/正文.md`
  }
  return `${chapter.章号}-${chapter.标题}.md`
}
