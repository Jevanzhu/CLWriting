/**
 * 自愈打回 —— 依据 ⑩ 第 6 节 + 母本第 4.1/4.2 节。
 *
 * 机检红项 > 0 → 自动退回阶段 4 写稿重写。
 * 重试到上限 → 升级 ask 作者（人话，不给堆栈）。
 * 黄项不打回——随草稿进三审。
 *
 * M2 的写稿用桩（手工伪造草稿）；真 AI 写稿在 M4。
 * 本模块实现「打回判定 + 重试计数 + 超限升级」的控制逻辑。
 */

import type { CheckReport } from '../check/types.js'
import { hasRed, getRedItems } from '../check/types.js'
import { formatRedForRewrite } from '../check/report.js'

/** 自愈打回状态 */
export type RetryState =
  | { state: 'pass' } // 无红项，放行进三审
  | { state: 'retry'; attempt: number; maxAttempts: number; redFeedback: string } // 退回重写
  | { state: 'escalate'; attempt: number; redFeedback: string } // 超限升级 ask 作者

/**
 * 自愈打回控制。
 *
 * @param report 机检报告
 * @param attempt 当前重试次数（从 1 起）
 * @param maxAttempts 最大重试次数（book.yaml 可配，默认 3）
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

  // 超过上限 → 升级 ask 作者
  if (attempt >= maxAttempts) {
    return {
      state: 'escalate',
      attempt,
      redFeedback: `已重试 ${attempt} 次仍有 ${reds.length} 条红项，需作者介入：\n${redFeedback}`,
    }
  }

  // 退回重写
  return {
    state: 'retry',
    attempt,
    maxAttempts,
    redFeedback,
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
