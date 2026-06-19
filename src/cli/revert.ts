/**
 * `clwriting revert <章号> [书目录]` —— 回滚「回到第 N 章」（#16 第 5 节，横切命令）。
 *
 * 任意态可触发（#15 之外的横切命令）。作者下达 → git 回退 + 缓存重建 + 工作区清理，三者一致。
 * 丢弃内容先进备份 ref（可找回）。输出人话，不出 git 命令/SHA。
 */

import process from 'node:process'
import { join } from 'node:path'
import { rollbackToChapter } from '../git/rollback.js'
import { resolveBookRoot } from '../install/books.js'
import { readBookConfig } from '../format/yaml.js'

/** `clwriting revert <章号/篇号> [书目录]` 命令处理器（长短分轨，M8 #26） */
export function revertCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printRevertHelp()
    return
  }

  if (args.length === 0 || !args[0]) {
    printRevertHelp(console.error)
    process.exit(1)
  }

  const chapterN = Number(args[0])
  if (!Number.isFinite(chapterN) || chapterN < 1) {
    console.error(`章号/篇号得是正整数，你给的是「${args[0]}」。`)
    process.exit(1)
  }

  // args[0]=章号/篇号，args[1]=可选书目录；书目录经 resolveBookRoot（支持活动书/cwd 兜底）
  const resolved = resolveBookRoot(args.slice(1))
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }
  const bookRoot = resolved.bookRoot
  // 读 kind 决定前缀/文案（M8 #26）：short → pc: + 「篇」，long/缺省 → ch: + 「章」
  const kind = readBookConfig(join(bookRoot, 'book.yaml')).config.kind ?? 'long'
  const result = rollbackToChapter(bookRoot, chapterN, kind)

  if (result.ok) {
    console.log(result.humanMsg)
  } else {
    console.error(`✗ ${result.humanMsg}`)
    process.exit(1)
  }
}

function printRevertHelp(write: (message: string) => void = console.log): void {
  write('用法：clwriting revert <回到第几章/篇> [书目录]')
  write('例：clwriting revert 152   # 长篇：回到第 152 章定稿后的状态')
  write('    clwriting revert 3     # 短篇集：回到第 3 篇定稿后的状态')
}
