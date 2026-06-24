/**
 * `clwriting finalize [草稿文件] [书目录]` —— 阶段 8 定稿薄门面。
 *
 * CLI 只装配草稿、book.yaml、缓存和审稿裁决标记；原子 commit 与前置闸仍由 finalize/commit.ts 单源处理。
 */

import process from 'node:process'
import { resolve, join, dirname } from 'node:path'
import { existsSync, rmSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from '../format/frontmatter.js'
import { readChapter } from '../format/chapters.js'
import { readPiece } from '../format/pieces.js'
import { readBookConfig } from '../format/yaml.js'
import { rebuild } from '../cache/rebuild.js'
import { doFinalize } from '../finalize/commit.js'
import { readReviewVerdict } from '../review/run.js'
import { resolveBookRoot } from '../install/books.js'
import { warnIfGuiActive } from '../process/gui-active.js'
import { pendingRoot, readBatchProgress, writeBatchProgress } from '../auto/batch.js'
import { aggregateLeadUpdates, readChapterLeadUpdates } from '../process/lead-updates.js'
import type { ChapterMeta } from '../format/types.js'

/** `clwriting finalize [draftPath] [bookRoot]` 命令处理器 */
export function finalizeCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printFinalizeHelp()
    return
  }

  // --from 指向待定稿章目录（M6 #35 R2）：workDir = 待定稿章目录，bookRoot 从它上溯定位
  const fromArg = argValue(args, '--from')
  const filteredArgs = filterFlag(args, '--from')

  let workDir: string
  let bookRoot: string
  let draftPath: string

  if (fromArg) {
    // 待定稿定稿：workDir 指向 待定稿/<章>/；bookRoot 上溯找含 book.yaml 的目录
    workDir = resolve(fromArg)
    const found = findBookRootFromPath(workDir)
    if (!found) {
      console.error(`✗ 从 --from 路径找不到书仓库（缺 book.yaml）：${fromArg}`)
      process.exit(1)
    }
    bookRoot = found
    draftPath = join(workDir, '草稿-1.md')
  } else {
    const resolved = resolveDraftAndBook(filteredArgs)
    draftPath = resolved.draftPath
    bookRoot = resolved.bookRoot
    workDir = join(bookRoot, '工作区')
  }

  const outlinePath = join(workDir, '细纲.md')
  warnIfGuiActive(bookRoot) // #1.5 GUI 活跃轻提示
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
  let failedReason: string | null = null
  try {
    // 账本履历落盘（账本 CLI 接缝修复）：长篇从 账本推进.md 装配 leadUpdates（证据命中草稿正文的才落，补当前章号）
    const leadUpdates = isShort
      ? undefined
      : aggregateLeadUpdates(readChapterLeadUpdates(workDir), draft.body, draft.chapter.章号)
    const result = doFinalize({
      bookRoot,
      workDir,
      outlinePath,
      db,
      config,
      chapter: draft.chapter,
      body: draft.body,
      fileName: finalChapterFileName(draft.chapter, isShort),
      hasReviewVerdict: readReviewVerdict(workDir).approved,
      kind: isShort ? 'short' : 'long',
      leadUpdates,
    })

    if (!result.ok) {
      failedReason = result.reason
    } else {
      const unit = isShort ? '篇' : '章'
      console.log(`✓ 第 ${draft.chapter.章号} ${unit}已定稿（commit ${result.commitHash}）`)
      if (fromArg) cleanupPendingSource(bookRoot, workDir, draft.chapter.章号)
    }
  } finally {
    db.close()
  }

  if (failedReason !== null) {
    console.error(`✗ ${failedReason}`)
    process.exit(1)
  }
}

function printFinalizeHelp(): void {
  console.log('用法：clwriting finalize [草稿文件] [书目录]')
  console.log('定稿并提交；需要确认记录、机检通过、审稿裁决。')
}

function resolveDraftAndBook(positional: string[]): { draftPath: string; bookRoot: string } {
  // 草稿文件（.md 结尾）是第一个位置参；书目录是第二个
  if (positional[0]?.endsWith('.md')) {
    const draftPath = resolve(positional[0])
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
    // 短篇草稿用 篇号（readPiece），映射成 ChapterMeta（章号字段承载篇号）
    const piece = readPiece(draftPath)
    if (!piece.ok) return { ok: false, reason: draftParseReason(piece.error.message, true) }
    const file = readFile(draftPath)
    if (!file.ok) return { ok: false, reason: draftParseReason(file.error.message, true) }
    // 目标情绪/核心反转是 PieceMeta 直属字段，带进 _raw 供 doFinalize 映射回 PieceMeta 保留
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

function draftParseReason(message: string, isShort: boolean): string {
  if (message.includes('front matter')) {
    if (isShort) {
      return `${message}。草稿必须以短篇 front matter 开头，至少包含：篇号、标题、目标情绪、核心反转。`
    }
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

/** 定稿文件名规则（kind 分支）：
 *  - long：定稿/正文/<章号>-<标题>.md（扁平）
 *  - short：篇/<篇号3位>-<标题>/正文.md（子路径，doFinalize 短篇分支 join(bookRoot,'篇',fileName)）
 */
function finalChapterFileName(chapter: ChapterMeta, isShort: boolean): string {
  if (isShort) {
    return `${String(chapter.章号).padStart(3, '0')}-${chapter.标题}/正文.md`
  }
  return `${chapter.章号}-${chapter.标题}.md`
}

function cleanupPendingSource(bookRoot: string, workDir: string, chapter: number): void {
  if (dirname(workDir) !== pendingRoot(bookRoot)) return
  rmSync(workDir, { recursive: true, force: true })
  const progress = readBatchProgress(bookRoot)
  if (!progress) return
  progress.completed = progress.completed.filter((c) => c !== chapter)
  writeBatchProgress(bookRoot, progress)
}

/** 取 flag 的值（如 --from <path>）。无 flag 或无值返回 undefined。 */
function argValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const val = args[idx + 1]
  return val && !val.startsWith('--') ? val : undefined
}

/** 从 args 剥离 flag 及其值，返回剩余参数。 */
function filterFlag(args: readonly string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      i++ // 跳过 flag 的值
      continue
    }
    out.push(args[i]!)
  }
  return out
}

/** 从给定路径上溯找最近的含 book.yaml 的目录（书仓库定位）。 */
function findBookRootFromPath(start: string): string | null {
  let dir = resolve(start)
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'book.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}
