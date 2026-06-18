/**
 * `clwriting confirm <章号> [书目录]` —— 阶段 2 确认细纲薄门面。
 *
 * 只负责把 CLI 参数接到 #11 doConfirm；确认记录、哈希绑定和 auto 开关仍由 gate/confirm.ts 单源处理。
 */

import process from 'node:process'
import { resolve, join } from 'node:path'
import { doConfirm } from '../gate/confirm.js'
import { readBookConfig } from '../format/yaml.js'

/** `clwriting confirm <章号> [bookRoot] [--auto]` 命令处理器 */
export function confirmCommand(args: string[]): void {
  const auto = args.includes('--auto')
  const positional = args.filter((a) => a !== '--auto')

  if (!positional[0]) {
    console.error('用法：clwriting confirm <章号> [书目录] [--auto]')
    process.exit(1)
  }

  const chapter = Number(positional[0])
  if (!Number.isSafeInteger(chapter) || chapter < 1) {
    console.error(`章号得是正整数，你给的是「${positional[0]}」。`)
    process.exit(1)
  }

  const bookRoot = positional[1] ? resolve(positional[1]) : process.cwd()
  const workDir = join(bookRoot, '工作区')
  const outlinePath = join(workDir, '细纲.md')
  const config = readBookConfig(join(bookRoot, 'book.yaml')).config

  const result = doConfirm(workDir, chapter, outlinePath, auto ? 'auto' : 'manual', config)
  if (!result.ok) {
    console.error(`✗ ${result.reason}`)
    process.exit(1)
  }

  console.log(`✓ 第 ${chapter} 章细纲已确认（${result.record.mode}，${result.record.outline_hash}）`)
}
