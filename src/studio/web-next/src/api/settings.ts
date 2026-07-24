import { apiJson } from './client'

// 设定台（#7.5）：GET /settings → 角色卡 + 角色关系边（关系图数据源，块5）。

export interface CharacterCard {
  file: string
  姓名: string
  身份: string
  目标: string
  境界: string
  关系: string
  正文: string
}

export interface RelationEdge {
  from: string
  to: string
  type: string
}

/** 债务子图边（块5 D2）：欠方 → 债主（来自 大纲/关系债） */
export interface DebtEdge {
  编号: string
  标题: string
  状态: string
  欠方: string
  债主: string
}

export interface SettingsResult {
  kind: 'long' | 'short'
  characters: CharacterCard[]
  characterRelations: RelationEdge[]
  debtGraph: DebtEdge[]
}

export async function getSettings(name: string): Promise<SettingsResult> {
  return apiJson<SettingsResult>(`/api/books/${encodeURIComponent(name)}/settings`)
}
