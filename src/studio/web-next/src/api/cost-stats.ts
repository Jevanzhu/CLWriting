// cost-stats 客户端（渲染）：配价书金额聚合；未配价 enabled:false。
import { apiJson } from './client'
import { bookUrl } from './url'

export interface CostBucket {
  cost: number
  calls: number
}

export interface CostStats {
  enabled: boolean
  /** true = 服务端事件库读失败（空壳语义是「读不到」，而非「未配价/零成本」）——
   *  与 enabled:false 分态渲染，不把观测层故障伪装成配置引导。 */
  degraded?: boolean
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
