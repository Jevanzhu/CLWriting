/**
 * `clwriting finalize [草稿文件] [书目录]` —— 阶段 8 定稿薄门面。
 *
 * CLI 只装配草稿、book.yaml、缓存和审稿裁决标记；原子 commit 与前置闸仍由 finalize/commit.ts 单源处理。
 */

import process from 'node:process'
import { resolve, join, dirname } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from '../format/frontmatter.js'
import { readChapter } from '../format/chapters.js'
import { readBookConfig } from '../format/yaml.js'
import { rebuild } from '../cache/rebuild.js'
import { doFinalize } from '../finalize/commit.js'
import { readReviewVerdict } from '../review/run.js'
import { resolveBookRoot } from '../install/books.js'
import { pendingRoot, readBatchProgress, writeBatchProgress } from '../auto/batch.js'
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
  const draft = readDraft(draftPath)
  if (!draft.ok) {
    console.error(`✗ ${draft.reason}`)
    process.exit(1)
  }
  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  const isShort = (config.kind ?? 'long') === 'short'
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
): { ok: true; chapter: ChapterMeta; body: string } | { ok: false; reason: string } {
  const chapter = readChapter(draftPath)
  if (!chapter.ok) return { ok: false, reason: chapter.error.message }

  const file = readFile(draftPath)
  if (!file.ok) return { ok: false, reason: file.error.message }

  return { ok: true, chapter: chapter.chapter, body: file.body }
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
