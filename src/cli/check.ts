/**
 * `clwriting check [草稿文件] [书目录]` —— 阶段 5 机检薄门面。
 *
 * 复用 #10 runAllChecks 与报告分级；红项用退出码 1 硬卡，黄项只提醒。
 */

import process from 'node:process'
import { resolve, join, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readBookConfig } from '../format/yaml.js'
import { rebuild } from '../cache/rebuild.js'
import { runAllChecks, hasRed } from '../check/runner.js'
import { formatReport } from '../check/report.js'
import { resolveBookRoot } from '../install/books.js'
import { warnIfGuiActive } from '../process/gui-active.js'
import { readOutlineLeads } from '../process/materials.js'
import { leadEvidenceMatchesBody, readChapterLeadUpdates } from '../process/lead-updates.js'
import { readDraft, finalChapterFileName } from '../format/draft.js'

/** `clwriting check [draftPath] [bookRoot] [--full]` 命令处理器 */
export function checkCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printCheckHelp()
    return
  }

  const mode = args.includes('--full') ? 'full' : 'brief'
  const strictShort = args.includes('--strict-short')
  const positional = args.filter((a) => a !== '--full' && a !== '--strict-short')
  const { draftPath, bookRoot } = resolveDraftAndBook(positional)
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
      strictShort,
    })
    console.log(formatReport(report, mode))
    hasBlockingRed = hasRed(report)
  } finally {
    db.close()
  }
  if (hasBlockingRed) process.exit(1)
}

function printCheckHelp(): void {
  console.log('用法：clwriting check [草稿文件] [书目录] [--full] [--strict-short]')
  console.log('运行机检；红项退出码 1，黄项只提醒。')
  console.log('--strict-short  短篇专属黄项按红项处理，用于真实生产硬闸。')
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
