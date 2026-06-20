/**
 * `clwriting health [书目录]` —— 单独触发 git 健康检查（#16 第 2 节，#15 态 1）。
 *
 * 作者怀疑书仓库 git 有问题时单独敲这个（不必走完整 enter 流程）。
 * 输出各异常的人话 + 修复指引；干净则报平安。
 *
 * 体检周期闭环（#15 第 6 节）：git 干净时顺手记一笔「体检做到当前章」，
 * 让状态机态 6 的「该体检了」提示消除（作者跑一次 health 即算体检）。
 *
 * 子参数（体检体系，两块各自分支独立、勿互相覆盖）：
 * - 无参：git 体检（现状，不动）
 * - --metrics：成本/审查指标报告（块 A，读 .cache/metrics.jsonl）
 * - --style [--freeze]：文风重扫报告 + 基线对照（块 B）
 * - --report：三维综合（两块合龙）
 */

import process from 'node:process'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gitHealthCheck } from '../git/exec.js'
import { writeHealthCheck } from '../cache/healthcheck.js'
import { rebuild } from '../cache/rebuild.js'
import { resolveBookRoot } from '../install/books.js'
import { readMetrics } from '../metrics/ledger.js'
import { aggregateMetrics, formatMetricsReport } from '../metrics/report.js'
import {
  scanLongChapters,
  scanShortPieces,
  aggregateStyleTrend,
  formatStyleReport,
  readBaseline,
  freezeBaseline,
  baselinePath,
  type ChapterSample,
} from '../metrics/style.js'
import { readBookConfig } from '../format/yaml.js'

/** `clwriting health [bookRoot] [子参数]` 命令处理器 */
export function healthCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printHealthHelp()
    return
  }

  // 子参数分发（体检体系）：各分支独立 return，勿改 git 体检默认路径
  const styleMode = args.includes('--style')
  const metricsMode = args.includes('--metrics')
  const reportMode = args.includes('--report')
  const freezeMode = args.includes('--freeze')

  if (styleMode || reportMode || metricsMode) {
    const resolved = resolveBookRoot(args)
    if (!resolved.ok) {
      console.error(`✗ ${resolved.reason}`)
      process.exit(1)
    }
    const bookRoot = resolved.bookRoot
    const last = parseLast(args)

    if (styleMode) {
      // 块 B 文风重扫（含 --freeze）—— #8/#9 实现
      runStyleReport(bookRoot, freezeMode, last)
      return
    }
    if (reportMode) {
      // 块 A+B 综合（#12 合龙）：文风重扫 + 成本/审查读账
      runFullReport(bookRoot, last)
      return
    }
    // metricsMode
    runMetricsReport(bookRoot, last)
    return
  }

  // 默认：git 体检（现状逻辑，不动）
  const resolved = resolveBookRoot(args)
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }
  const bookRoot = resolved.bookRoot

  const report = gitHealthCheck(bookRoot)
  if (report.clean) {
    console.log('✓ 书仓库 git 干净，没有半提交 / 冲突 / 锁 / 同步盘副本残留。')
    printWarnings(report.warnings)
    // 体检闭环：干净则记账，消除态 6 提示（#15 第 6 节）
    markHealthCheckDone(bookRoot)
    return
  }

  console.log(`✗ 发现 ${report.issues.length} 个问题，逐个处理：\n`)
  for (const issue of report.issues) {
    console.log(`· ${issue.humanMsg}`)
    console.log(`  怎么办：${issue.fix}`)
    if (issue.files && issue.files.length > 0) {
      console.log(`  相关文件：${issue.files.join('、')}`)
    }
    console.log()
  }
  printWarnings(report.warnings)
}

/** 解析 --last=N 参数（看近 N 章/篇） */
function parseLast(args: string[]): number | undefined {
  for (const a of args) {
    const m = a.match(/^--last=(\d+)$/)
    if (m) return Math.max(1, Number(m[1]))
  }
  return undefined
}

/** 块 A：成本/审查指标报告 */
function runMetricsReport(bookRoot: string, last: number | undefined): void {
  const records = readMetrics(bookRoot)
  const report = aggregateMetrics(records, { last })
  process.stdout.write(formatMetricsReport(report))
}

/** 块 B：文风重扫报告（--style），或冻结基线（--style --freeze，#9） */
function runStyleReport(bookRoot: string, freeze: boolean, last: number | undefined): void {
  // --style --freeze：冻结基线（#9）
  if (freeze) {
    try {
      const baseline = freezeBaseline(bookRoot)
      console.log(`✓ 文风基线已冻结到 ${baselinePath(bookRoot)}`)
      console.log(`  ${Object.keys(baseline.byScene).length} 个场景：${Object.keys(baseline.byScene).join('、')}`)
    } catch (e) {
      console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
      process.exit(1)
    }
    return
  }

  // --style：重扫聚合 + 漂移 + 基线对照（#8）
  const kind = resolveKind(bookRoot)
  const samples = recentStyleSamples(
    kind === 'short' ? scanShortPieces(bookRoot) : scanLongChapters(bookRoot),
    last,
  )
  const baseline = readBaseline(bookRoot)
  const trend = aggregateStyleTrend(samples, kind, baseline)
  process.stdout.write(formatStyleReport(trend))
}

/** 综合 --report（#12 合龙）：文风重扫 + 成本/审查读账 */
function runFullReport(bookRoot: string, last: number | undefined): void {
  const kind = resolveKind(bookRoot)
  // 文风段（块 B 重扫）
  const samples = recentStyleSamples(
    kind === 'short' ? scanShortPieces(bookRoot) : scanLongChapters(bookRoot),
    last,
  )
  const baseline = readBaseline(bookRoot)
  const trend = aggregateStyleTrend(samples, kind, baseline)
  process.stdout.write(formatStyleReport(trend))
  // 成本/审查段（块 A 读账）
  const records = readMetrics(bookRoot)
  const report = aggregateMetrics(records, { last })
  process.stdout.write(formatMetricsReport(report))
}

function recentStyleSamples(samples: ChapterSample[], last: number | undefined): ChapterSample[] {
  if (last === undefined || last <= 0 || samples.length <= last) return samples
  return [...samples].sort((a, b) => a.num - b.num).slice(-last)
}

/** 解析书仓库 kind（long/short）；读不到配置默认 long */
function resolveKind(bookRoot: string): 'long' | 'short' {
  try {
    const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
    if (cfg.ok) return cfg.config.kind === 'short' ? 'short' : 'long'
  } catch {
    // 配置读不到，默认 long
  }
  return 'long'
}

function printWarnings(warnings: ReturnType<typeof gitHealthCheck>['warnings']): void {
  if (warnings.length === 0) return
  console.log('\n安全提醒：')
  for (const warning of warnings) {
    console.log(`· ${warning.humanMsg}`)
    console.log(`  怎么办：${warning.fix}`)
    if (warning.remotes && warning.remotes.length > 0) {
      console.log(`  remote：${warning.remotes.join('、')}`)
    }
  }
}

function printHealthHelp(): void {
  console.log('用法：clwriting health [书目录] [子参数]')
  console.log('')
  console.log('子参数：')
  console.log('  （无参）          git 健康检查；干净时记录一次体检完成')
  console.log('  --metrics         成本/审查指标报告（读 .cache/metrics.jsonl）')
  console.log('  --style           文风重扫报告 + 基线对照')
  console.log('  --style --freeze  冻结文风基线（文风/基线.json）')
  console.log('  --report          三维综合（文风重扫 + 成本/审查读账）')
  console.log('  --last=N          只看近 N 章/篇')
}

/** 记体检完成（先重建缓存，再读当前章号写 health-check.json；失败不阻断 health 命令） */
function markHealthCheckDone(bookRoot: string): void {
  const cachePath = join(bookRoot, '.cache', 'index.db')
  try {
    // health 可单独运行，不能假设 enter 已经把缓存重建到最新。
    rebuild(bookRoot, cachePath)
    const db = new DatabaseSync(cachePath)
    let currentChapter = 0
    try {
      const row = db.prepare('SELECT MAX(number) AS maxNum FROM chapters').get() as
        | { maxNum: number | null }
        | undefined
      currentChapter = row?.maxNum ?? 0
    } finally {
      db.close()
    }
    writeHealthCheck(bookRoot, currentChapter)
  } catch {
    // 读缓存失败不阻断 health 命令本身（体检记账是附带功能）
  }
}
