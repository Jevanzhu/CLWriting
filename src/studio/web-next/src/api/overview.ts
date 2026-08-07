import { apiJson } from './client'

// 总览（细案 §2.3 T4.1）：GET /overview → 身份/进度/状态机/卷结构/写作热力。
// 长短篇按 identity.kind 分流：长篇 volumes+words 实质，短篇 volumes=[] words=0。

export interface OverviewIdentity {
  name: string
  kind: 'long' | 'short'
  path: string
  created_at?: string
  title: string
  genre: string
  host: string
}
export interface OverviewProgress {
  chapters: number
  words: number
  targetWords?: number
  percent?: number
}
export interface ShortProfile {
  targetEmotions?: string[]
  targetReversalTypes?: string[]
  targetEndingFlavors?: string[]
  seriesMotifs?: string[]
}

export interface OverviewResult {
  identity: OverviewIdentity
  progress: OverviewProgress
  // detail 失败时 { error }；成功时是完整 DetectedState（前端不深挖，只取 state/name/error）
  state: { state: number; name: string; detail: { error?: string } & Record<string, unknown> }
  volumes: { name: string; path: string }[]
  timeline: { date: string; count: number }[]
  recentDoc: { no: number; 标题: string; path: string } | null
  streak: number
  /** 短篇画像（book.yaml.short 配置，总览页缺口分析用） */
  shortProfile?: ShortProfile
}

export async function getOverview(name: string): Promise<OverviewResult> {
  return apiJson<OverviewResult>(`/api/books/${encodeURIComponent(name)}/overview`)
}
