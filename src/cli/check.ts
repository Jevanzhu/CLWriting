/**
 * `clwriting check [草稿文件] [书目录]` —— 阶段 5 机检薄门面。
 *
 * 复用 #10 runAllChecks 与报告分级；红项用退出码 1 硬卡，黄项只提醒。
 */

import process from 'node:process'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from '../format/frontmatter.js'
import { readChapter } from '../format/chapters.js'
import { readBookConfig } from '../format/yaml.js'
import { rebuild } from '../cache/rebuild.js'
import { runAllChecks, hasRed } from '../check/runner.js'
import { formatReport } from '../check/report.js'
import { resolveBookRoot } from '../install/books.js'
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

  const draft = readDraft(draftPath)
  if (!draft.ok) {
    console.error(`✗ ${draft.reason}`)
    process.exit(1)
  }

  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
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
    const report = runAllChecks({
      db,
      bookRoot,
      config,
      chapter: draft.chapter,
      body: draft.body,
      fileName: finalChapterFileName(draft.chapter),
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
): { ok: true; chapter: ChapterMeta; body: string } | { ok: false; reason: string } {
  const chapter = readChapter(draftPath)
  if (!chapter.ok) return { ok: false, reason: chapter.error.message }

  const file = readFile(draftPath)
  if (!file.ok) return { ok: false, reason: file.error.message }

  return { ok: true, chapter: chapter.chapter, body: file.body }
}

function finalChapterFileName(chapter: ChapterMeta): string {
  return `${chapter.章号}-${chapter.标题}.md`
}
