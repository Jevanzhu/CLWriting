/**
 * learn 候选入库 —— 作者审核挑选后的候选写入文风条目库（文风系统重整 S8）。
 *
 * 样章候选 → 样章条目（说明=技法指令）；金句候选 → 样章条目 + 标签[金句]。
 * 来源统一「收割」；序号/目录由 addEntry 统一管理（文风/条目/样章/）。
 *
 * 红线：作者审核才入库（只处理传入的 picks，不自动入库）。
 */

import { addEntry } from '../format/style-entry.js'
import type { SampleCandidate, QuoteCandidate } from './index.js'

/**
 * 样章候选入库（作者挑选后调用）。
 * @returns 入库的文件路径列表（相对书仓库）
 */
export function commitSamples(bookRoot: string, picks: SampleCandidate[]): string[] {
  return picks.map((pick) =>
    addEntry(bookRoot, {
      类型: '样章',
      场景: pick.场景,
      来源: '收割',
      ...(pick.技法指令 ? { 说明: pick.技法指令 } : {}),
      出处: pick.出处,
      正文: pick.正文,
    }),
  )
}

/**
 * 金句候选入库（样章条目 + 标签[金句]，供注入层按标签取用）。
 * @returns 入库的文件路径列表（相对书仓库）
 */
export function commitQuotes(bookRoot: string, picks: QuoteCandidate[]): string[] {
  return picks.map((pick) =>
    addEntry(bookRoot, {
      类型: '样章',
      场景: pick.场景,
      来源: '收割',
      标签: ['金句'],
      出处: pick.出处,
      正文: pick.正文,
    }),
  )
}
