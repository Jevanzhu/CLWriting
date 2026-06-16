/**
 * 机检报告 + CLI 输出分级 —— 依据 ⑩ 第 7 节附录。
 *
 * --brief（AI 默认）：红项逐条明细 + 黄项分类计数
 * --full：红 + 黄全明细
 */

import type { CheckReport, CheckItem } from './types.js'

/** 报告输出模式（⑩ 第 7 节） */
export type ReportMode = 'brief' | 'full'

/** 机检报告 → 文本输出 */
export function formatReport(report: CheckReport, mode: ReportMode): string {
  const lines: string[] = []

  const reds: CheckItem[] = []
  const yellows: CheckItem[] = []
  for (const s of report.sections) {
    for (const i of s.items) {
      if (i.level === 'red') reds.push(i)
      else yellows.push(i)
    }
  }

  // 红项：两种模式都逐条明细
  if (reds.length > 0) {
    lines.push(`🔴 红项 ${reds.length} 条（必须修复）`)
    for (const r of reds) {
      lines.push(`  [${r.checkId}] ${r.message}`)
    }
    lines.push('')
  }

  // 黄项
  if (yellows.length > 0) {
    if (mode === 'brief') {
      // 分类计数
      lines.push(`🟡 黄项 ${yellows.length} 条（参考，不卡）`)
      const bySection = new Map<string, number>()
      for (const s of report.sections) {
        const yellowCount = s.items.filter((i) => i.level === 'yellow').length
        if (yellowCount > 0) bySection.set(s.name, yellowCount)
      }
      for (const [name, count] of bySection) {
        lines.push(`  ${name} ${count} 处`)
      }
    } else {
      // full：逐条明细
      lines.push(`🟡 黄项 ${yellows.length} 条`)
      for (const y of yellows) {
        lines.push(`  [${y.checkId}] ${y.message}`)
      }
    }
    lines.push('')
  }

  if (reds.length === 0 && yellows.length === 0) {
    lines.push('✅ 机检通过，无红无黄')
  }

  return lines.join('\n')
}

/** 自愈打回的红项清单文本（⑩ 第 6 节：回灌给写稿重写） */
export function formatRedForRewrite(report: CheckReport): string {
  const reds = report.sections.flatMap((s) => s.items.filter((i) => i.level === 'red'))
  if (reds.length === 0) return ''
  const lines = ['请修复以下红项后重写：']
  for (const r of reds) {
    lines.push(`- ${r.message}`)
  }
  return lines.join('\n')
}
