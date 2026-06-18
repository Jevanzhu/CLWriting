/**
 * `clwriting knowledge check` —— M4 知识层 manifest 校验薄门面。
 */

import process from 'node:process'
import { formatKnowledgeManifestReport, validateKnowledgeManifest } from '../knowledge/manifest.js'
import { resolveBookRoot } from '../install/books.js'

/** `clwriting knowledge check [书目录]` */
export function knowledgeCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printKnowledgeHelp()
    return
  }

  const subcommand = args[0]
  if (subcommand !== 'check') {
    printKnowledgeHelp(console.error)
    process.exit(1)
  }

  // args[0]='check' 子命令，args[1]=可选书目录
  const resolved = resolveBookRoot(args.slice(1))
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }
  const bookRoot = resolved.bookRoot
  const report = validateKnowledgeManifest(bookRoot)
  console.log(formatKnowledgeManifestReport(report))
  if (!report.ok) process.exit(1)
}

function printKnowledgeHelp(write: (message: string) => void = console.log): void {
  write('用法：clwriting knowledge check [书目录]')
}
