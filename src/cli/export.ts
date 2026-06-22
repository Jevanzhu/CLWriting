/**
 * `clwriting export` —— 干净导出定稿正文（M7 #36）。
 *
 * 把定稿正文导出成多形态（单文件合并 / 分章），剥所有 front matter，
 * 产物落 `工作区/导出/`。作用于活动书（M5 #32 resolveBookRoot）。
 */

import process from 'node:process'
import { resolveBookRoot } from '../install/books.js'
import { exportBook, type ExportFormat, type ExportPlatform } from '../export/index.js'

const PLATFORM_OPTIONS: ExportPlatform[] = ['generic', 'wechat', 'zhihu-salt', 'fanqie', 'xiaohongshu']

/** `clwriting export` */
export function exportCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：clwriting export [--format <merged|split|both>] [--platform <模板>] [书目录]')
    console.log()
    console.log('把定稿正文干净导出（剥所有 front matter），长篇按章，短篇集按篇。')
    console.log('短篇集会额外生成 投稿视图-<集名>.md，便于出版/投稿整理。')
    console.log()
    console.log('选项：')
    console.log('  --format merged  单文件合并（长篇全本 / 短篇全篇集）')
    console.log('  --format split   分章/分篇导出（工作区/导出/分章|分篇/）')
    console.log('  --format both    两者都导出（默认）')
    console.log('  --platform generic|wechat|zhihu-salt|fanqie|xiaohongshu')
    console.log('                  短篇投稿视图模板（默认 generic；长篇忽略）')
    console.log()
    console.log('正文导出只取定稿正文，不含账本/大纲/工作区/摘要。')
    return
  }

  // 解析 --format
  let format: ExportFormat = 'both'
  const formatIdx = args.indexOf('--format')
  if (formatIdx !== -1 && args[formatIdx + 1]) {
    const val = args[formatIdx + 1] as ExportFormat
    if (val === 'merged' || val === 'split' || val === 'both') {
      format = val
    } else {
      console.error(`✗ --format 必须是 merged / split / both，收到：${val}`)
      process.exit(1)
    }
  }
  let platform: ExportPlatform = 'generic'
  const platformIdx = args.indexOf('--platform')
  if (platformIdx !== -1 && args[platformIdx + 1]) {
    const val = args[platformIdx + 1] as ExportPlatform
    if (PLATFORM_OPTIONS.includes(val)) {
      platform = val
    } else {
      console.error(`✗ --platform 必须是 ${PLATFORM_OPTIONS.join(' / ')}，收到：${val}`)
      process.exit(1)
    }
  }
  const skip = new Set<number>()
  if (formatIdx !== -1) {
    skip.add(formatIdx)
    skip.add(formatIdx + 1)
  }
  if (platformIdx !== -1) {
    skip.add(platformIdx)
    skip.add(platformIdx + 1)
  }
  const bookArgs = args.filter((_, i) => !skip.has(i))

  // 解析书仓库（作用于活动书）
  const r = resolveBookRoot(bookArgs)
  if (!r.ok) {
    console.error(`✗ ${r.reason}`)
    process.exit(1)
  }

  const result = exportBook({ bookRoot: r.bookRoot, format, platform })
  if (!result.ok) {
    console.error(`✗ ${result.error}`)
    process.exit(1)
  }

  console.log(`✓ 已导出 ${result.chapterCount} ${result.unit}：`)
  for (const f of result.files) {
    console.log(`  ${f}`)
  }
}
