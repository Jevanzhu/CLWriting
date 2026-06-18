/**
 * `clwriting use <书名>` —— 切换当前活动书（#32 第 5 节）。
 *
 * 换书只改 .clwriting/active 一个文件，不动 books.jsonl、不动书仓库。
 * cwd 在某书仓库内时走解析链第 3 档（cwd 优先），不受 active 影响。
 */

import process from 'node:process'
import { findWorkDir, readBooks, writeActive } from '../install/books.js'

/** `clwriting use <书名>` */
export function useCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：clwriting use <书名>')
    console.log('切换当前活动书（之后裸 clwriting enter 等命令默认作用于这本书）。')
    return
  }

  const name = args.find((a) => !a.startsWith('--'))
  if (!name) {
    console.error('✗ 要给书名。用法：clwriting use <书名>')
    process.exit(1)
  }

  const workDir = findWorkDir(process.cwd())
  if (!workDir) {
    console.error('✗ 当前不在 CLWriting 工作目录（找不到 .clwriting/）。先 clwriting init 建一个。')
    process.exit(1)
  }

  const books = readBooks(workDir)
  const entry = books.find((b) => b.name === name)
  if (!entry) {
    console.error(`✗ 没找到叫「${name}」的书。已登记的书：`)
    if (books.length === 0) {
      console.error('  （还没有书，先 clwriting init 建一本）')
    } else {
      for (const b of books) console.error(`  · ${b.name}（${b.kind === 'short' ? '短篇集' : '长篇'}）`)
    }
    process.exit(1)
  }

  writeActive(workDir, name)
  console.log(`✓ 当前活动书：${name}`)
  console.log('敲 `clwriting enter` 进这本书。')
}
