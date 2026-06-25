/** 设定（对接 GET /api/books/:name/settings；境界/角色/时间线/关系图） */

export interface RealmSystem {
  名称: string
  序列: string[]
}

export interface FreeCard {
  标题: string
  摘要: string
}

export interface CharacterCard {
  file: string
  姓名: string
  身份: string
  目标: string
  境界: string
  关系: string
  正文: string
}

export interface CharacterRelation {
  from: string
  to: string
  type: string
}

export interface DebtEdge {
  编号: string
  标题: string
  状态: string
  欠方: string
  债主: string
}

export interface SettingsData {
  kind: 'long'
  realm: { 体系: RealmSystem[]; 正文?: string } | null
  characters: CharacterCard[]
  timeline: FreeCard[]
  debtGraph: DebtEdge[]
  characterRelations: CharacterRelation[]
}
