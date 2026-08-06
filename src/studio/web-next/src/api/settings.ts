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
  note?: string
}

/** 债务子图边（块5 D2）：欠方 → 债主（来自 大纲/关系线） */
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
  /** 关系缓存新鲜度（用于自动触发判断） */
  relationCache?: { chapterCount: number | null; currentChapters: number }
}

export async function getSettings(name: string): Promise<SettingsResult> {
  return apiJson<SettingsResult>(`/api/books/${encodeURIComponent(name)}/settings`)
}

/** AI 关系梳理：触发 AI 通读材料提炼关系边，落盘缓存。force=true 强制重梳理。 */
export async function mineRelations(name: string, force = false): Promise<{ ok: boolean; cached: boolean; relations: { from: string; to: string; type: string; note?: string }[] }> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/relations/mine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  })
}

/** 补全名称列表（编辑器补全用；轻量端点：角色姓名 + 物品名称，只读 fm 不拉正文） */
export interface CompletionNames {
  characters: string[]
  items: string[]
}
export async function getCompletionNames(name: string): Promise<CompletionNames> {
  return apiJson<CompletionNames>(`/api/books/${encodeURIComponent(name)}/completion-names`)
}
