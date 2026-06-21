/**
 * `clwriting check [草稿文件] [书目录]` —— 阶段 5 机检薄门面。
 *
 * 复用 #10 runAllChecks 与报告分级；红项用退出码 1 硬卡，黄项只提醒。
 */

import process from 'node:process'
import { resolve, join, dirname } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from '../format/frontmatter.js'
import { readChapter } from '../format/chapters.js'
import { readPiece } from '../format/pieces.js'
import { readBookConfig } from '../format/yaml.js'
import { rebuild } from '../cache/rebuild.js'
import { runAllChecks, hasRed } from '../check/runner.js'
import { formatReport } from '../check/report.js'
import { resolveBookRoot } from '../install/books.js'
import { readOutlineLeads } from '../process/materials.js'
import { leadEvidenceMatchesBody, readChapterLeadUpdates } from '../process/lead-updates.js'
import type { ChapterMeta } from '../format/types.js'

/** `clwriting check [draftPath] [bookRoot] [--full]` 命令处理器 */
export function checkCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printCheckHelp()
    return
  }

  const mode = args.includes('--full') ? 'full' : 'brief'
  const positional = args.filter((a) => a !== '--full')
  const { draftPath, bookRoot } = resolveDraftAndBook(positional)

  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  const isShort = (config.kind ?? 'long') === 'short'

  const draft = readDraft(draftPath, isShort)
  if (!draft.ok) {
    console.error(`✗ ${draft.reason}`)
    process.exit(1)
  }

  const cachePath = join(bookRoot, '.cache', 'index.db')
  const rebuilt = rebuild(bookRoot, cachePath)
  if (rebuilt.errors.length > 0) {
    console.error('✗ 源文件解析失败，先修这些文件：')
    for (const e of rebuilt.errors) {
      console.error(`· ${e.file}${e.line > 0 ? ` 第${e.line}行` : ''}：${e.message}`)
    }
    process.exit(1)
  }

  const db = new DatabaseSync(cachePath)
  let hasBlockingRed = false
  try {
    // 账本两端闭合数据流（账本 CLI 接缝修复）：长篇装配 declared（细纲 推进:）/ actual（账本推进.md 证据命中草稿正文的）
    const workDir = dirname(draftPath)
    const declaredLeadIds = isShort ? undefined : readOutlineLeads(workDir)
    const actualLeadIds = isShort
      ? undefined
      : readChapterLeadUpdates(workDir)
          .filter((u) => leadEvidenceMatchesBody(draft.body, u.证据))
          .map((u) => u.leadId)
    const report = runAllChecks({
      db: isShort ? undefined : db,
      bookRoot,
      config,
      chapter: draft.chapter,
      body: draft.body,
      fileName: finalChapterFileName(draft.chapter, isShort),
      declaredLeadIds,
      actualLeadIds,
    })
    console.log(formatReport(report, mode))
    hasBlockingRed = hasRed(report)
  } finally {
    db.close()
  }
  if (hasBlockingRed) process.exit(1)
}

function printCheckHelp(): void {
  console.log('用法：clwriting check [草稿文件] [书目录] [--full]')
  console.log('运行机检；红项退出码 1，黄项只提醒。')
}

function resolveDraftAndBook(positional: string[]): { draftPath: string; bookRoot: string } {
  // 草稿文件（.md 结尾）是第一个位置参；书目录是第二个
  if (positional[0]?.endsWith('.md')) {
    const draftPath = resolve(positional[0])
    // 第二个位置参（书目录）经 resolveBookRoot，支持活动书/cwd 兜底
    const resolved = resolveBookRoot(undefined, positional[1])
    if (!resolved.ok) {
      console.error(`✗ ${resolved.reason}`)
      process.exit(1)
    }
    return { draftPath, bookRoot: resolved.bookRoot }
  }

  // 无草稿位置参：位置参直接是书目录
  const resolved = resolveBookRoot(positional)
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }
  return { draftPath: join(resolved.bookRoot, '工作区', '草稿-1.md'), bookRoot: resolved.bookRoot }
}

function readDraft(
  draftPath: string,
  isShort: boolean,
): { ok: true; chapter: ChapterMeta; body: string } | { ok: false; reason: string } {
  if (!existsSync(draftPath)) {
    return { ok: false, reason: missingDraftReason(draftPath) }
  }
  if (isShort) {
    // 短篇草稿用 篇号（readPiece），映射成 ChapterMeta（章号字段承载篇号）供 runAllChecks 短篇分支
    const piece = readPiece(draftPath)
    if (!piece.ok) return { ok: false, reason: piece.error.message }
    const file = readFile(draftPath)
    if (!file.ok) return { ok: false, reason: file.error.message }
    // 目标情绪/核心反转是 PieceMeta 直属字段，带进 _raw 供 finalize 映射回 PieceMeta 保留
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
  if (!chapter.ok) return { ok: false, reason: draftParseReason(chapter.error.message) }

  const file = readFile(draftPath)
  if (!file.ok) return { ok: false, reason: draftParseReason(file.error.message) }

  return { ok: true, chapter: chapter.chapter, body: file.body }
}

function draftParseReason(message: string): string {
  if (message.includes('front matter')) {
    return `${message}。草稿必须以章节 front matter 开头，至少包含：章号、标题、钩子类型、钩子强弱、情绪定位。`
  }
  return message
}

function missingDraftReason(draftPath: string): string {
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

function finalChapterFileName(chapter: ChapterMeta, isShort: boolean): string {
  if (isShort) {
    return `${String(chapter.章号).padStart(3, '0')}-${chapter.标题}/正文.md`
  }
  return `${chapter.章号}-${chapter.标题}.md`
}
