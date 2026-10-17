/**
 * 总览回包契约（前端 api/overview.ts 与服务端 overview 端点共用）。
 *
 * 服务端 payload 由 overview.ts 组装；`state.detail` 是状态机内部结构（前端只读
 * state/name，不深挖 detail），故按不透明对象声明。漂移由 overview.conformance.ts
 * 钉住（服务端 payload 以本类型注解）。
 */

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

export interface OverviewState {
  state: number
  name: string
  /** 状态机明细——结构随判定器变化，前端不读内部字段。 */
  detail: unknown
}

export interface OverviewVolume {
  name: string
  path: string
}

export interface OverviewTimelinePoint {
  date: string
  count: number
}

export interface OverviewRecentDoc {
  no: number
  标题: string
  path: string
}

/** GET /overview 回包。 */
export interface OverviewResult {
  identity: OverviewIdentity
  progress: OverviewProgress
  state: OverviewState
  volumes: OverviewVolume[]
  timeline: OverviewTimelinePoint[]
  recentDoc: OverviewRecentDoc | null
  streak: number
  shortProfile?: ShortProfile
}
