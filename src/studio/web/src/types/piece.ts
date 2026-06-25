/** 篇详情（短篇灵魂，#6.5；对接 GET /api/books/:name/piece/:no） */

export interface PieceSummary {
  篇号: number
  标题: string
  字数: number
  目标情绪?: string
  核心反转?: string
}

export interface EmotionPoint {
  段落: string
  情绪: string
  强度: number
  说明?: string
}

export interface SetupPoint {
  位置: string
  内容: string
}

export interface PayoffEntry {
  伏笔: string
  回收位置: string
  未回收?: boolean
}

export interface PieceListData {
  反转线索表: { 核心反转: string; 铺垫点: SetupPoint[] }
  情绪曲线?: EmotionPoint[]
  伏笔回收: PayoffEntry[]
}

export interface PieceDetailData {
  meta: PieceSummary
  body: string
  list: PieceListData
}
