/**
 * `clwriting revert <章号> [书目录]` —— 回滚「回到第 N 章」（⑯ 第 5 节，横切命令）。
 *
 * 任意态可触发（⑮ 之外的横切命令）。作者下达 → git 回退 + 缓存重建 + 工作区清理，三者一致。
 * 丢弃内容先进备份 ref（可找回）。输出人话，不出 git 命令/SHA。
 */

import process from 'node:process'
import { resolve } from 'node:path'
import { rollbackToChapter } from '../git/rollback.js'

/** `clwriting revert <章号> [书目录]` 命令处理器 */
export function revertCommand(args: string[]): void {
  if (args.length === 0 || !args[0]) {
    console.error('用法：clwriting revert <回到第几章> [书目录]')
    console.error('例：clwriting revert 152   # 回到第 152 章定稿后的状态')
    process.exit(1)
  }

  const chapterN = Number(args[0])
  if (!Number.isFinite(chapterN) || chapterN < 1) {
    console.error(`章号得是正整数，你给的是「${args[0]}」。`)
    process.exit(1)
  }

  const bookRoot = args[1] ? resolve(args[1]) : process.cwd()
  const result = rollbackToChapter(bookRoot, chapterN)

  if (result.ok) {
    console.log(result.humanMsg)
  } else {
    console.error(`✗ ${result.humanMsg}`)
    process.exit(1)
  }
}
