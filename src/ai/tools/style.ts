/**
 * harvest_style：文风收割（write，产候选落 工作区/learn候选，不自动入库）。
 * 复用 learnFromBook（与 CLI 收割同链路；标注权在作者）。
 */
import { learnFromBook } from '../../learn/index.js'
import type { ToolContext, ToolResult } from './context.js'

export function harvestStyle(ctx: ToolContext, _input: Record<string, unknown>): ToolResult {
  const r = learnFromBook(ctx.bookRoot)
  if (!r.ok) return { ok: false, summary: r.error ?? '文风收割失败。' }
  return {
    ok: true,
    summary: '文风收割完成：采样 ' + r.sampleCount + ' 段 / 金句候选 ' + r.quoteCount + ' 条，已写入 ' + r.candidateDir + '。请在文风收割界面标注候选（不入库自动归，标注权在作者）。'
  }
}

