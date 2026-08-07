import { apiJson } from './client'

// 节奏双轨（块4）：GET /rhythm → 长篇(written/planned 双轨) / 短篇(篇长+目标情绪)。
// written=写作/正文 已写实际；planned=大纲/章纲 规划（字数目标合计）。

export interface RhythmDist {
  [key: string]: number
}

export interface RhythmTrack {
  count: number
  hookTypeDist: RhythmDist
  hookLevelDist: RhythmDist
  emotionDist: RhythmDist
  sceneDist: RhythmDist
}

export interface RhythmWordPoint {
  章号: number
  标题: string
  字数: number
}

/** 逐章偏差行（D3）：状态 待写/即兴/对比；对比时字段 "规→实"，跑偏 *偏差=true。 */
export interface ChapterDiffRow {
  章号: number
  标题: string
  状态: '待写' | '即兴' | '对比'
  钩子类型?: string
  钩子类型偏差?: boolean
  情绪定位?: string
  情绪定位偏差?: boolean
  场景?: string
  场景偏差?: boolean
  字数?: string
}

export interface RhythmLong {
  kind: 'long'
  wordCurve: RhythmWordPoint[]
  avgWords: number
  chapterDiff: ChapterDiffRow[]
  written: RhythmTrack & { sceneEmotion: Record<string, Record<string, number>> }
  planned: RhythmTrack & { targetWords: number }
}

export interface RhythmShort {
  kind: 'short'
  wordCurve: { 篇号: number; 标题: string; 字数: number }[]
  emotionDist: RhythmDist
  reversals: { 篇号: number; 标题: string; 核心反转: string }[]
  /** 连续故事节奏分布（有钩子字段时返回，独立短篇无） */
  written?: RhythmTrack
}

export type RhythmResult = RhythmLong | RhythmShort

export async function getRhythm(name: string): Promise<RhythmResult> {
  return apiJson<RhythmResult>(`/api/books/${encodeURIComponent(name)}/rhythm`)
}
