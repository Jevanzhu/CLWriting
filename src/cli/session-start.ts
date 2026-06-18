/**
 * `clwriting session-start` —— M4 #24 SessionStart hook 薄门面。
 *
 * 输出给 AI 的有界近况注入文本。无 hook 宿主仍可手动运行 `clwriting enter`。
 */

import process from 'node:process'
import { buildSessionStartInjection } from '../session/injection.js'
import { resolveBookRoot } from '../install/books.js'

/** `clwriting session-start [书目录]` 命令处理器 */
export function sessionStartCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printSessionStartHelp()
    return
  }

  const resolved = resolveBookRoot(args)
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }
  const bookRoot = resolved.bookRoot
  const injection = buildSessionStartInjection(bookRoot)
  process.stdout.write(injection.text)
}

function printSessionStartHelp(): void {
  console.log('用法：clwriting session-start [书目录]')
  console.log('输出给 AI 的有界会话起始近况注入文本。')
}
