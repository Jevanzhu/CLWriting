/** 节奏（对接 GET /api/books/:name/rhythm；长/短篇双轨） */

export interface RhythmLong {
  kind: 'long'
  wordCurve: { 章号: number; 标题: string; 字数: number }[]
  avgWords: number
  hookTypeDist: Record<string, number>
  hookLevelDist: Record<string, number>
  emotionDist: Record<string, number>
  sceneDist: Record<string, number>
  sceneEmotion: Record<string, Record<string, number>>
}

export interface RhythmShort {
  kind: 'short'
  wordCurve: { 篇号: number; 标题: string; 字数: number }[]
  emotionDist: Record<string, number>
  reversals: { 篇号: number; 标题: string; 核心反转: string }[]
}

export type Rhythm = RhythmLong | RhythmShort
