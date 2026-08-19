// cost-stats 客户端（D2 批 5 / D1 批 4 渲染）：配价书金额聚合；未配价 enabled:false。
import { apiJson } from './client'

export interface CostBucket {
  cost: number
  calls: number
}

export interface CostStats {
  enabled: boolean
  currency?: string
  total: number
  byDay: Record<string, CostBucket>
  byTask: Record<string, CostBucket>
  byChapter: Record<string, CostBucket>
  unpricedModels: string[]
}

/** GET /api/books/:name/cost-stats */
export async function getCostStats(bookName: string): Promise<CostStats> {
  return apiJson<CostStats>(`/api/books/${encodeURIComponent(bookName)}/cost-stats`)
}
