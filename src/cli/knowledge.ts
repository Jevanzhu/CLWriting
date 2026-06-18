/**
 * `clwriting knowledge check` —— M4 知识层 manifest 校验薄门面。
 */

import process from 'node:process'
import { resolve } from 'node:path'
import { formatKnowledgeManifestReport, validateKnowledgeManifest } from '../knowledge/manifest.js'

/** `clwriting knowledge check [书目录]` */
export function knowledgeCommand(args: string[]): void {
  const subcommand = args[0]
  if (subcommand !== 'check') {
    printKnowledgeHelp()
    process.exit(1)
  }

  const bookRoot = args[1] ? resolve(args[1]) : process.cwd()
  const report = validateKnowledgeManifest(bookRoot)
  console.log(formatKnowledgeManifestReport(report))
  if (!report.ok) process.exit(1)
}

function printKnowledgeHelp(): void {
  console.error('用法：clwriting knowledge check [书目录]')
}
