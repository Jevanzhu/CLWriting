/**
 * `clwriting export` —— 干净导出定稿正文（M7 #36）。
 *
 * 把定稿正文导出成多形态（单文件合并 / 分章），剥所有 front matter，
 * 产物落 `工作区/导出/`。作用于活动书（M5 #32 resolveBookRoot）。
 */

import process from 'node:process'
import { resolveBookRoot } from '../install/books.js'
import { exportBook, type ExportFormat } from '../export/index.js'

/** `clwriting export` */
export function exportCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：clwriting export [--format <merged|split|both>] [书目录]')
    console.log()
    console.log('把定稿正文干净导出（剥所有 front matter）。')
    console.log()
    console.log('选项：')
    console.log('  --format merged  单文件合并（工作区/导出/全本-<书名>.md）')
    console.log('  --format split   分章导出（工作区/导出/分章/）')
    console.log('  --format both    两者都导出（默认）')
    console.log()
    console.log('导出只取定稿正文，不含账本/大纲/工作区/摘要。')
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
  const bookArgs = formatIdx === -1 ? args : args.filter((_, i) => i !== formatIdx && i !== formatIdx + 1)

  // 解析书仓库（作用于活动书）
  const r = resolveBookRoot(bookArgs)
  if (!r.ok) {
    console.error(`✗ ${r.reason}`)
    process.exit(1)
  }

  const result = exportBook({ bookRoot: r.bookRoot, format })
  if (!result.ok) {
    console.error(`✗ ${result.error}`)
    process.exit(1)
  }

  console.log(`✓ 已导出 ${result.chapterCount} 章：`)
  for (const f of result.files) {
    console.log(`  ${f}`)
  }
}
