/**
 * `clwriting import` —— 导入 v0.2 正文（M7 #36）。
 *
 * 统一导入入口，length-routing 自动判定长短篇。
 * 长篇走本命令（复用 scaffold 建书），短篇分流到 M8。
 */

import process from 'node:process'
import { findWorkDir } from '../install/books.js'
import { importV02Book } from '../import/index.js'

/** `clwriting import` */
export function importCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：clwriting import <v0.2正文路径> [--name 书名] [--kind long|short] [--genre 题材]')
    console.log()
    console.log('导入 v0.2 正文到 v1 书仓库（复用 scaffold 建书）。')
    console.log()
    console.log('参数：')
    console.log('  <v0.2正文路径>       v0.2 正文文件（.md）')
    console.log('  --name <书名>        书名（可选，从文件名推导）')
    console.log('  --kind long|short    长短篇（可选，自动判定：章节数≥5 或字数≥30000 为长篇）')
    console.log('  --genre <题材>       题材（可选，驱动账本类推荐）')
    console.log()
    console.log('自动判定（length-routing）：优先级 --kind > 章节数≥5 > 字数≥30000；短篇分流 M8。')
    console.log('导入后：正文落 定稿/正文/，元数据占位（钩子/情绪填默认，_raw 标「导入: 待标注」）。')
    return
  }

  // 解析位置参（v0.2 正文路径）
  const positional = args.filter((a) => !a.startsWith('--'))
  if (positional.length === 0) {
    console.error('✗ 缺少 v0.2 正文路径')
    console.error('用法：clwriting import <v0.2正文路径>')
    process.exit(1)
  }
  const sourcePath = positional[0]!

  // 解析可选参数
  const val = (flag: string): string | undefined => {
    const idx = args.indexOf(flag)
    return idx !== -1 ? args[idx + 1] : undefined
  }
  const name = val('--name')
  const genre = val('--genre')
  let kind: 'long' | 'short' | undefined
  const kindVal = val('--kind')
  if (kindVal) {
    if (kindVal !== 'long' && kindVal !== 'short') {
      console.error(`✗ --kind 必须是 long / short，收到：${kindVal}`)
      process.exit(1)
    }
    kind = kindVal
  }

  // 定位工作目录（CLI 层负责，逻辑层不碰 process.cwd）
  const workDir = findWorkDir(process.cwd())
  if (!workDir) {
    console.error('✗ 当前不在 CLWriting 工作目录（找不到 .clwriting/）。先 clwriting init 建工作目录。')
    process.exit(1)
  }

  const result = importV02Book({ sourcePath, workDir, name, kind, genre })
  if (!result.ok) {
    console.error(`✗ ${result.error}`)
    process.exit(1)
  }

  console.log(`✓ 已导入 ${result.chapterCount} 章（${result.kind}）`)
  console.log(`  书名：${result.bookName}`)
  console.log(`  路径：${result.bookRoot}`)
  console.log()
  console.log('下一步：')
  console.log('  1. 补章节元数据（钩子/情绪）—— 导入占位为「待标注」')
  console.log('  2. 补账本/设定（v1 账本是新规划，只搬正文不搬投影）')
  console.log('  3. clwriting enter 体检')
  console.log('  4. clwriting learn 收割样章候选')
}
