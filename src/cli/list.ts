/**
 * `clwriting list` —— 列出已登记的所有书（#32 第 5 节）。
 *
 * 标当前活动书；kind 区分长篇/短篇集。
 */

import process from 'node:process'
import { findWorkDir, readBooks, readActive } from '../install/books.js'

/** `clwriting list` */
export function listCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：clwriting list')
    console.log('列出工作目录下已登记的所有书。')
    return
  }

  const workDir = findWorkDir(process.cwd())
  if (!workDir) {
    console.error('✗ 当前不在 CLWriting 工作目录（找不到 .clwriting/）。先 clwriting init 建一个。')
    process.exit(1)
  }

  const books = readBooks(workDir)
  const active = readActive(workDir)

  if (books.length === 0) {
    console.log('还没有书。敲 `clwriting init` 建第一本。')
    return
  }

  console.log(`共 ${books.length} 本书：`)
  for (const b of books) {
    const mark = b.name === active ? ' ★ 当前' : ''
    const kindLabel = b.kind === 'short' ? '短篇集' : '长篇'
    console.log(`· ${b.name}（${kindLabel}）${mark}`)
  }
}
