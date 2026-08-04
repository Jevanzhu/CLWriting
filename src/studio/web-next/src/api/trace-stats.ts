// trace-stats 客户端（B3 规则命中统计 + T3 AI 调用指标）。
import { apiJson } from './client'

/** 单条规则命中统计（rule-hits.json 透出） */
export interface RuleHitEntry {
  ruleId: string
  hits: number
  lastHit: string
  recentMessages: string[]
}

/** trace-stats 响应（T3 聚合 + B3 ruleHits） */
export interface TraceStats {
  total: number
  byTask: Record<string, unknown>
  ruleHits: RuleHitEntry[]
}

/** GET /api/books/:name/trace-stats → 聚合指标 + 规则命中 */
export async function getTraceStats(bookName: string): Promise<TraceStats> {
  return apiJson<TraceStats>(`/api/books/${encodeURIComponent(bookName)}/trace-stats`)
}