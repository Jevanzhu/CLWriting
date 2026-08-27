/**
 * 机检报告产出 —— 依据 #10 第 6/7 节附录。
 *
 * R66-14（十四轮）：formatReport（--brief/--full CLI 文本输出）生产零调用——机检
 * 结果的消费面已全部 API 化（studio 端点直读结构化 CheckReport），CLI 分级输出为
 * 下沉遗留，随本轮清理删除（含 ReportMode 类型与 test/check/checks.test.ts 两用例）。
 */

import type { CheckReport } from './types.js'

/** 自愈打回的红项清单文本（#10 第 6 节：回灌给写稿重写） */
export function formatRedForRewrite(report: CheckReport): string {
  const reds = report.sections.flatMap((s) => s.items.filter((i) => i.level === 'red'))
  if (reds.length === 0) return ''
  const lines = ['请修复以下红项后重写：']
  for (const r of reds) {
    lines.push(`- ${r.message}`)
  }
  return lines.join('\n')
}
