/**
 * `clwriting rebook [书目录] [--yes]` —— 未入账手改补登门面。
 *
 * 默认只报告和给建议；显式 --yes 才把定稿/大纲手改保存为补登 commit。
 */

import process from 'node:process'
import { resolveBookRoot } from '../install/books.js'
import { handeditReport, formatHandEditReport } from '../reconcile/handedit.js'
import { addCommit } from '../git/exec.js'
import { rebuild } from '../cache/rebuild.js'
import { join } from 'node:path'

export function rebookCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printRebookHelp()
    return
  }

  const yes = args.includes('--yes')
  const positionals = args.filter((a) => a !== '--yes')
  const resolved = resolveBookRoot(positionals)
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }

  const bookRoot = resolved.bookRoot
  const { report, proposals } = handeditReport(bookRoot)
  console.log(formatHandEditReport(report))
  if (report.edits.length === 0) return

  if (!yes) {
    console.log('确认这些手改要入账后，运行：clwriting rebook --yes [书目录]')
    return
  }

  const rebuilt = rebuild(bookRoot, join(bookRoot, '.cache', 'index.db'))
  if (rebuilt.errors.length > 0) {
    console.error('✗ 源文件解析失败，先修这些文件：')
    for (const e of rebuilt.errors) {
      console.error(`· ${e.file}${e.line > 0 ? ` 第${e.line}行` : ''}：${e.message}`)
    }
    process.exit(1)
  }

  const paths = [...new Set(report.edits.map((e) => e.path))]
  const commit = addCommit(bookRoot, 'rebook: 补登手改', paths)
  if (!commit.ok) {
    console.error(`✗ ${commit.humanMsg}`)
    process.exit(1)
  }
  console.log(`✓ 手改已补登（commit ${commit.hash}）`)
  if (proposals.some((p) => p.needsImpactAnalysis)) {
    console.log('· 本次包含设定手改，后续写章前请结合影响分析确认顺势圆。')
  }
}

function printRebookHelp(): void {
  console.log('用法：clwriting rebook [书目录] [--yes]')
  console.log('报告未入账手改；加 --yes 后保存为补登 commit。')
}
