/**
 * 自愈打回 —— 依据 #10 第 6 节 + 母本第 4.1/4.2 节。
 *
 * 机检红项 > 0 → 自动退回阶段 4 写稿重写。
 * 重试到上限 → 升级 ask 作者（人话，不给堆栈）。
 * 黄项不打回——随草稿进三审。
 *
 * M2 写好状态机，由 `src/ai/orchestrate/self-heal.ts` 接线进 /auto-write 全自动写章闭环。
 * （编排器从 api 层迁入 ai/orchestrate 层：解耦 HTTP 语境，api/ 只留端点接线。）
 * 本模块实现「打回判定 + 重试计数 + 超限升级」的控制逻辑。
 */

import type { CheckReport } from '../check/types.js'
import { hasRed, getRedItems } from '../check/types.js'
import { formatRedForRewrite } from '../check/report.js'

/** 自愈打回状态 */
export type RetryState =
  | { state: 'pass' } // 无红项，放行进三审
  | { state: 'retry'; attempt: number; maxAttempts: number; redFeedback: string; redIssues: string[] } // 退回重写(attempt=即将进行的第几次重写)
  | { state: 'escalate'; attempt: number; redFeedback: string; redIssues: string[] } // 超限升级 ask 作者(attempt=已重写次数)

/**
 * 自愈打回控制。
 *
 * @param report 机检报告
 * @param attempt 已完成的重写次数(首检传 0)
 * @param maxAttempts 最大重写次数(默认 3)
 */
export function evaluateRetry(
  report: CheckReport,
  attempt: number,
  maxAttempts = 3,
): RetryState {
  // 无红项 → 放行
  if (!hasRed(report)) {
    return { state: 'pass' }
  }

  const redFeedback = formatRedForRewrite(report)
  const reds = getRedItems(report)
  const redIssues = reds.map((r) => r.message) // K13：结构化数组，消除字符串往返解析

  // 已重写满 maxAttempts 次仍红 → 升级 ask 作者
  if (attempt >= maxAttempts) {
    return {
      state: 'escalate',
      attempt,
      redFeedback: `已重试 ${attempt} 次仍有 ${reds.length} 条红项，需作者介入：\n${redFeedback}`,
      redIssues,
    }
  }

  // 退回重写:attempt+1 = 即将进行的第几次重写(供 UI 显示「第 N/M 次」)
  return {
    state: 'retry',
    attempt: attempt + 1,
    maxAttempts,
    redFeedback,
    redIssues,
  }
}

/** 打回状态 → 人话（供 CLI 输出） */
export function formatRetryState(s: RetryState): string {
  switch (s.state) {
    case 'pass':
      return '✅ 机检通过，进入审稿'
    case 'retry':
      return `🔄 第 ${s.attempt}/${s.maxAttempts} 次重写（红项打回）：\n${s.redFeedback}`
    case 'escalate':
      return `⚠️ 需作者介入：\n${s.redFeedback}`
  }
}

// ── A4（DSH-19）：连续相同红项 → 换策略提醒 ──────────

/**
 * 红项集合 canonical key：去重 + 排序后拼接。
 * 「同一章连续重写后红项**完全相同**」的判定基础（顺序无关、重复无关）。
 */
export function redSetKey(redIssues: string[]): string {
  return [...new Set(redIssues)].sort().join('\n')
}

/**
 * 换策略提醒文案（注入重写 prompt 的独立段落，不拦截——guard 只提供信息不夺权）。
 * 触发口径（决策 2）：本次机检红项与上一次重写前完全相同（第 2 次相同即提醒）。
 */
export function buildStrategyReminder(redIssues: string[]): string {
  return [
    '## 策略提醒（重要）',
    '以下红项与上一次重写前完全相同——同样的改法已经无效，不要原样微调措辞再试一遍：',
    ...redIssues.map((s) => `- ${s}`),
    '请先换定位再动笔：确认红项指向的根源（如正文事实与声明不一致、缺承接场景、表述与检查规则本身冲突），再换一种修法（改情节走向 / 补场景 / 调整该处信息量）；若红项无法通过重写正文消除，保持该处不动，优先保证其余红项收敛。',
  ].join('\n')
}
