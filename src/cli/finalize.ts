/**
 * `clwriting finalize [草稿文件] [书目录]` —— 阶段 8 定稿薄门面。
 *
 * CLI 只装配草稿、book.yaml、缓存和审稿裁决标记；原子 commit 与前置闸仍由 finalize/commit.ts 单源处理。
 */

import process from 'node:process'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from '../format/frontmatter.js'
import { readChapter } from '../format/chapters.js'
import { readBookConfig } from '../format/yaml.js'
import { rebuild } from '../cache/rebuild.js'
import { doFinalize } from '../finalize/commit.js'
import { readReviewVerdict } from '../review/run.js'
import type { ChapterMeta } from '../format/types.js'

/** `clwriting finalize [draftPath] [bookRoot]` 命令处理器 */
export function finalizeCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printFinalizeHelp()
    return
  }

  const { draftPath, bookRoot } = resolveDraftAndBook(args)
  const draft = readDraft(draftPath)
  if (!draft.ok) {
    console.error(`✗ ${draft.reason}`)
    process.exit(1)
  }

  const workDir = join(bookRoot, '工作区')
  const outlinePath = join(workDir, '细纲.md')
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
      fileName: finalChapterFileName(draft.chapter),
      hasReviewVerdict: readReviewVerdict(workDir).approved,
    })

    if (!result.ok) {
      failedReason = result.reason
    } else {
      console.log(`✓ 第 ${draft.chapter.章号} 章已定稿（commit ${result.commitHash}）`)
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
  if (positional[0]?.endsWith('.md')) {
    return {
      draftPath: resolve(positional[0]),
      bookRoot: positional[1] ? resolve(positional[1]) : process.cwd(),
    }
  }

  const bookRoot = positional[0] ? resolve(positional[0]) : process.cwd()
  return { draftPath: join(bookRoot, '工作区', '草稿-1.md'), bookRoot }
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
