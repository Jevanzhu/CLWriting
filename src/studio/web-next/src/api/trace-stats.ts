// trace-stats 客户端（规则命中统计 + AI 调用指标）。
import { apiJson } from './client'
import { bookUrl } from './url'

/** 单条规则命中统计（rule-hits.json 透出） */
export interface RuleHitEntry {
  ruleId: string
  hits: number
  lastHit: string
  recentMessages: string[]
}

/** trace-stats 响应（聚合 + ruleHits） */
export interface TraceStats {
  total: number
  byTask: Record<string, unknown>
  ruleHits: RuleHitEntry[]
  /** true = 服务端事件库读失败——total:0 是「读不到」而非「确无调用」。 */
  degraded?: boolean
}

/** GET /api/books/:name/trace-stats → 聚合指标 + 规则命中 */
export async function getTraceStats(bookName: string): Promise<TraceStats> {
  return apiJson<TraceStats>(bookUrl(bookName, 'trace-stats'))
}
