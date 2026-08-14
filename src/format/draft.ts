/**
 * 草稿/正文读取共享模块。
 *
 * 读正文区文件 → ChapterMeta + body，供 finalize/check/review/chat 共用。
 * 长短篇统一 readChapter（ChapterMeta 含可选 目标情绪/核心反转）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { relative, join } from 'node:path'
import { readFile, splitFrontMatter, parseFlat } from './frontmatter.js'
import { readChapter, readChapterDir } from './chapters.js'
import { readManifest } from '../document/manifest.js'
import type { ChapterMeta } from './types.js'

export type ReadDraftResult =
  | { ok: true; chapter: ChapterMeta; body: string }
  | { ok: false; reason: string }

/**
 * 读正文区文件 → ChapterMeta + body。
 * 统一 readChapter（章节 front matter：章号/标题/钩子/情绪/目标情绪/核心反转）。
 */
export function readDraft(draftPath: string): ReadDraftResult {
  if (!existsSync(draftPath)) {
    return { ok: false, reason: `找不到文件：${draftPath}` }
  }
  const chapter = readChapter(draftPath)
  if (!chapter.ok) return { ok: false, reason: draftParseReason(chapter.error.message) }
  const file = readFile(draftPath)
  if (!file.ok) return { ok: false, reason: draftParseReason(file.error.message) }
  return { ok: true, chapter: chapter.chapter, body: file.body }
}

/** 草稿 frontmatter 错误文案补全。 */
export function draftParseReason(message: string): string {
  if (message.includes('front matter')) {
    return `${message}。草稿必须以章节 front matter 开头，至少包含：章号、标题、钩子类型、钩子强弱、情绪定位。`
  }
  return message
}

/**
 * 定稿文件名规则：写作/正文/<章号3位>-<标题>.md（扁平）。
 */
export function finalChapterFileName(chapter: ChapterMeta): string {
  return `${String(chapter.章号).padStart(3, '0')}-${chapter.标题}.md`
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
  content?: string,
): { relPath: string; existed: boolean } {
  const bodyDir = join(bookRoot, '写作', '正文')

  // 1. 已有同章号 → 覆盖（V-P1-3：已定稿章除外——覆盖定稿 = 静默摧毁作者已确认内容）
  if (existsSync(bodyDir)) {
    const hit = readChapterDir(bodyDir).chapters.find((c) => c.章号 === chapter)
    if (hit?._path) {
      const relPath = slashRelative(bookRoot, hit._path)
      ensureChapterNotFinalized(bookRoot, relPath)
      return { relPath, existed: true }
    }
  }

  // 2. 新章 → 生成正式文件路径（标题净化路径分隔符，防 AI 产出含 ../ 的标题越出 bookRoot）
  const title = extractTitleFromContent(content) ?? `第${chapter}章`
  const fileName = `${String(chapter).padStart(3, '0')}-${title.replace(/[\\/\0]/g, '_')}.md`

  // 推断卷目录（上一章所在卷 > 最新卷 > 第一卷）
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

/** V-P1-3：目标章已定稿（manifest finalizedRevision 基线在位）→ 拒绝覆盖写。
 *  态 4 续写/对话 agent/自动连写的章号一旦指向已定稿章（如坏 fm 副本文件抢章号），
 *  无条件覆盖会静默摧毁定稿内容；fail-closed，由调用方提示作者走回滚或另立章号。
 *  清单缺失/不可读（legacy 书）无定稿信息可依 → 维持旧行为不阻断。 */
function ensureChapterNotFinalized(bookRoot: string, relPath: string): void {
  let manifest: ReturnType<typeof readManifest>
  try {
    manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  } catch {
    return
  }
  for (const e of manifest.entries.values()) {
    if (e.nodeType === 'document' && e.path === relPath && e.finalizedRevision) {
      throw new Error(`第 ${relPath} 章已定稿，拒绝覆盖写；如需重写请先回滚该章定稿或另立章号`)
    }
  }
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
