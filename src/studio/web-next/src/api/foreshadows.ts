import { apiJson } from './client'

// 伏笔/线索追踪：GET /foreshadows → 结构化列表（fm 字段 + 摘要）

export type ForeshadowStatus = '未回收' | '已回收' | '已废弃'
export type ForeshadowPriority = '高' | '中' | '低'

export interface Foreshadow {
  file: string
  标题: string
  状态: string
  埋设章号: number | null
  回收章号: number | null
  重要性: string
  摘要: string
}

export async function getForeshadows(name: string): Promise<Foreshadow[]> {
  return apiJson<Foreshadow[]>(`/api/books/${encodeURIComponent(name)}/foreshadows`)
}
