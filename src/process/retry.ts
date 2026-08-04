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
  | { state: 'retry'; attempt: number; maxAttempts: number; redFeedback: string } // 退回重写(attempt=即将进行的第几次重写)
  | { state: 'escalate'; attempt: number; redFeedback: string } // 超限升级 ask 作者(attempt=已重写次数)

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

  // 已重写满 maxAttempts 次仍红 → 升级 ask 作者
  if (attempt >= maxAttempts) {
    return {
      state: 'escalate',
      attempt,
      redFeedback: `已重试 ${attempt} 次仍有 ${reds.length} 条红项，需作者介入：\n${redFeedback}`,
    }
  }

  // 退回重写:attempt+1 = 即将进行的第几次重写(供 UI 显示「第 N/M 次」)
  return {
    state: 'retry',
    attempt: attempt + 1,
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
