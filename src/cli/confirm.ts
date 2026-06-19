/**
 * `clwriting confirm <章号> [书目录]` —— 阶段 2 确认细纲薄门面。
 *
 * 只负责把 CLI 参数接到 #11 doConfirm；确认记录、哈希绑定和 auto 开关仍由 gate/confirm.ts 单源处理。
 */

import process from 'node:process'
import { join } from 'node:path'
import { doConfirm } from '../gate/confirm.js'
import { readBookConfig } from '../format/yaml.js'
import { resolveBookRoot } from '../install/books.js'

/** `clwriting confirm <章号> [bookRoot] [--auto]` 命令处理器 */
export function confirmCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printConfirmHelp()
    return
  }

  const auto = args.includes('--auto')
  const positional = args.filter((a) => a !== '--auto')

  if (!positional[0]) {
    printConfirmHelp(console.error)
    process.exit(1)
  }

  const chapter = Number(positional[0])
  if (!Number.isSafeInteger(chapter) || chapter < 1) {
    console.error(`章号/篇号得是正整数，你给的是「${positional[0]}」。`)
    process.exit(1)
  }

  // positional[0]=章号/篇号，positional[1]=可选书目录
  const resolved = resolveBookRoot(positional.slice(1))
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }
  const bookRoot = resolved.bookRoot
  const workDir = join(bookRoot, '工作区')
  const outlinePath = join(workDir, '细纲.md')
  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  const isShort = (config.kind ?? 'long') === 'short'

  const result = doConfirm(workDir, chapter, outlinePath, auto ? 'auto' : 'manual', config)
  if (!result.ok) {
    console.error(`✗ ${result.reason}`)
    process.exit(1)
  }

  const unit = isShort ? '篇' : '章'
  console.log(`✓ 第 ${chapter} ${unit}细纲已确认（${result.record.mode}，${result.record.outline_hash}）`)
}

function printConfirmHelp(write: (message: string) => void = console.log): void {
  write('用法：clwriting confirm <章号> [书目录] [--auto]')
  write('确认工作区/细纲.md，并写入带哈希的确认记录。')
}
