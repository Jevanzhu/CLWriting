// cost-stats 客户端（批 5 / 批 4 渲染）：配价书金额聚合；未配价 enabled:false。
import { apiJson } from './client'
import { bookUrl } from './url'

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
  return apiJson<CostStats>(bookUrl(bookName, 'cost-stats'))
}
