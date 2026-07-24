import { apiJson } from './client'

// 节奏双轨（块4）：GET /rhythm → 长篇(written/planned 双轨) / 短篇(篇长+目标情绪)。
// written=定稿/正文 已写实际；planned=大纲/章纲 规划（字数目标合计）。

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

export interface RhythmLong {
  kind: 'long'
  wordCurve: RhythmWordPoint[]
  avgWords: number
  written: RhythmTrack & { sceneEmotion: Record<string, Record<string, number>> }
  planned: RhythmTrack & { targetWords: number }
}

export interface RhythmShort {
  kind: 'short'
  wordCurve: { 篇号: number; 标题: string; 字数: number }[]
  emotionDist: RhythmDist
  reversals: { 篇号: number; 标题: string; 核心反转: string }[]
}

export type RhythmResult = RhythmLong | RhythmShort

export async function getRhythm(name: string): Promise<RhythmResult> {
  return apiJson<RhythmResult>(`/api/books/${encodeURIComponent(name)}/rhythm`)
}
