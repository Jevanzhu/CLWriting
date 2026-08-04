import { apiJson } from './client'

// 伏笔/线索追踪：GET /foreshadows → 结构化列表（fm 字段 + 足迹 + 风险）

export type ForeshadowStatus = '未回收' | '已回收' | '已废弃'
export type ForeshadowPriority = '高' | '中' | '低'

/** 单次足迹命中（关联词在正文中的出现） */
export interface ForeshadowHit {
  章号: number
  命中词: string
  命中片段: string
}

/** 伏笔足迹 + 风险评估 */
export interface ForeshadowTrail {
  hits: ForeshadowHit[]
  firstHit: number | null
  lastHit: number | null
  staleSpan: number
  risk: '红' | '黄' | '绿'
}

export interface Foreshadow {
  file: string
  标题: string
  状态: string
  埋设章号: number | null
  回收章号: number | null
  重要性: string
  关联词: string[]
  摘要: string
  足迹: ForeshadowTrail | null
}

export async function getForeshadows(name: string): Promise<Foreshadow[]> {
  return apiJson<Foreshadow[]>(`/api/books/${encodeURIComponent(name)}/foreshadows`)
}
