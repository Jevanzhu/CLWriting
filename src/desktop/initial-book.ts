/**
 * RB-SV-P2-4：--book 直进参数解析（名或路径 → 书架登记名）。
 *
 * Electron 启动参数 `--book <名|路径>` 或 env CLWRITING_INITIAL_BOOK，在起 server 前
 * 经 setInitialBook 注入 /api/boot（前端 boot 后直达该书工作区）；second-instance
 * 收到同参时主窗口直达。路径解析沿用书架登记口径：相对 workDir 或绝对路径命中
 * entry.path 均认；不匹配任何登记书则忽略（前端回落默认书架页）。
 */
import { resolve } from 'node:path'
import { readBooks } from '../install/books.js'

/** 从 argv 取 --book 值；无则回落 CLWRITING_INITIAL_BOOK env。 */
export function initialBookArg(argv: string[]): string | undefined {
  const i = argv.indexOf('--book')
  const fromArg = i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined
  const v = fromArg ?? process.env['CLWRITING_INITIAL_BOOK']
  const t = typeof v === 'string' ? v.trim() : ''
  return t || undefined
}

/** 解析为书架登记书名：直接命中名册名 / 路径（相对 workDir 或绝对）命中登记 path；未命中返回 null。 */
export function resolveInitialBook(workDir: string, ref: string): string | null {
  const books = readBooks(workDir)
  if (books.some((b) => b.name === ref)) return ref
  const abs = resolve(workDir, ref)
  const byPath = books.find((b) => resolve(workDir, b.path) === abs)
  return byPath ? byPath.name : null
}
