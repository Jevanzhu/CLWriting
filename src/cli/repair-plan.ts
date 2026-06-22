/**
 * `clwriting repair-plan` —— 短篇重修计划。
 *
 * 只读已定稿短篇、清单与指标账，把 health --report 发现的弱项转成可执行
 * 改稿动作。不写文件，不替作者自动改正文。
 */

import process from 'node:process'
import { join } from 'node:path'
import { resolveBookRoot } from '../install/books.js'
import { readBookConfig } from '../format/yaml.js'
import { readMetrics } from '../metrics/ledger.js'
import {
  analyzeShortRepairPlan,
  formatShortRepairPlan,
  scanShortCollection,
} from '../metrics/short-index.js'

export function repairPlanCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printRepairPlanHelp()
    return
  }

  const last = parseLast(args)
  const bookArgs = args.filter((arg) => !arg.startsWith('--last='))
  const resolved = resolveBookRoot(bookArgs)
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }

  const bookRoot = resolved.bookRoot
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  if (!cfg.ok || cfg.config.kind !== 'short') {
    console.error('✗ repair-plan 目前只支持短篇书。')
    process.exit(1)
  }

  const entries = recentByNum(scanShortCollection(bookRoot), last)
  const records = recentByNum(readMetrics(bookRoot).filter((record) => record.kind === 'short'), last)
  const report = analyzeShortRepairPlan(entries, cfg.config.short, records)
  process.stdout.write(formatShortRepairPlan(report))
}

function printRepairPlanHelp(): void {
  console.log('用法：clwriting repair-plan [书目录] [--last=N]')
  console.log('')
  console.log('读取已定稿短篇、清单与指标账，输出每篇重修优先级、弱项和建议动作。')
  console.log('适合在 clwriting health --report 后运行。')
  console.log('')
  console.log('选项：')
  console.log('  --last=N  只看近 N 篇')
}

function parseLast(args: string[]): number | undefined {
  for (const arg of args) {
    const match = arg.match(/^--last=(\d+)$/)
    if (match) return Math.max(1, Number(match[1]))
  }
  return undefined
}

function recentByNum<T extends { num: number }>(items: T[], last: number | undefined): T[] {
  if (last === undefined || items.length <= last) return items
  return [...items].sort((a, b) => a.num - b.num).slice(-last)
}
