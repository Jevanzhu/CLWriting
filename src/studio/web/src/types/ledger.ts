/** 账本（对接 GET /api/books/:name/leads；长篇七类 + 短篇集子） */

export interface LeadEntry {
  章号: number
  动词: string
  证据: string
  回填?: boolean
}

export interface Lead {
  编号: string
  标题: string
  类型: string
  状态: string
  开启章: number
  履历: LeadEntry[]
  境界体系?: string
  当前境界?: string
  父局线?: string
  欠方?: string
  债主?: string
}

export interface LedgerOverview {
  类型: string
  total: number
  进行中: number
  已收尾: number
  已放弃: number
}

export interface Stale {
  编号: string
  类型: string
  标题: string
  开启章: number
  最后履历章: number
  距今: number
}

/** 短篇集子单行（#7.3 跨篇聚合） */
export interface CollectionRow {
  篇号: number
  标题: string
  字数: number
  目标情绪?: string
  核心反转?: string
  情绪峰值?: number
  情绪类型?: string
  回收率?: string
  未回收数?: number
}

export interface MatrixCell {
  章号: number
  编号: string
  类型: string
  标题: string
  动词: string
  证据: string
}

export interface LeadsDataLong {
  kind: 'long'
  overview: LedgerOverview[]
  leads: Lead[]
  matrix: MatrixCell[]
  currentChapter: number
  stale: Stale[]
}

export interface LeadsDataShort {
  kind: 'short'
  pieces: CollectionRow[]
  summary: { 总篇数: number; 总字数: number; 平均篇长: number }
}

export type LeadsData = LeadsDataLong | LeadsDataShort
