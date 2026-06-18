/**
 * `clwriting repair` —— M5 #32 自愈门面。
 *
 * books.jsonl 缺失/损坏 → 扫描工作目录直接子目录重建登记；
 * 书目录被移动 → 标 missing 提示重关联。不报错拒绝（文件即真相）。
 */

import process from 'node:process'
import { findWorkDir, repairBooks } from '../install/books.js'

/** `clwriting repair` */
export function repairCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：clwriting repair')
    console.log('自愈 books.jsonl：扫描工作目录重建书登记；报告被移动的书。')
    return
  }

  const workDir = findWorkDir(process.cwd())
  if (!workDir) {
    console.error('✗ 当前不在 CLWriting 工作目录（找不到 .clwriting/）。先 clwriting init 建一个。')
    process.exit(1)
  }

  const result = repairBooks(workDir)

  if (!result.changed && result.missing.length === 0) {
    console.log('✓ 书登记完好，无需修复。')
    return
  }

  // 重建/补登的书
  if (result.rebuilt.length > 0) {
    console.log(`✓ 书登记已重建，共 ${result.rebuilt.length} 本：`)
    for (const b of result.rebuilt) {
      const kindLabel = b.kind === 'short' ? '短篇集' : '长篇'
      console.log(`  · ${b.name}（${kindLabel}）`)
    }
  }

  // 自动重关联的书
  if (result.relinked.length > 0) {
    console.log(`✓ 已重新关联 ${result.relinked.length} 本移动/改名的书：`)
    for (const item of result.relinked) {
      console.log(`  · ${item.name}：${item.from} → ${item.to}`)
    }
  }

  // 被移动/丢失的书
  if (result.missing.length > 0) {
    console.log(`⚠ 发现 ${result.missing.length} 本登记的书目录找不到（可能被移动/改名/删除）：`)
    for (const b of result.missing) {
      console.log(`  · ${b.name}（原路径 ${b.path}）`)
    }
    console.log('这些登记已保留。若只是移动了，把书移回工作目录再跑一次 repair，或按新位置手动调整 books.jsonl。')
  }
}
