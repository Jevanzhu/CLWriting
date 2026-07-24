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

export interface SettingsResult {
  kind: 'long' | 'short'
  characters: CharacterCard[]
  characterRelations: RelationEdge[]
}

export async function getSettings(name: string): Promise<SettingsResult> {
  return apiJson<SettingsResult>(`/api/books/${encodeURIComponent(name)}/settings`)
}
