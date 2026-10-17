/**
 * 伏笔回包契约（前端 api/foreshadows.ts 与服务端 foreshadows 端点共用）。
 *
 * 服务端权威类型 = src/document/foreshadow.ts 的 ForeshadowEntry / ForeshadowHit /
 * ForeshadowTrail；端点回包 = 条目 + 足迹。漂移由 foreshadows.conformance.ts 钉住。
 */

export interface ForeshadowHit {
  章号: number
  命中词: string
  命中片段: string
}

export interface ForeshadowTrail {
  hits: ForeshadowHit[]
  firstHit: number | null
  lastHit: number | null
  staleSpan: number
  risk: '红' | '黄' | '绿'
}

/** GET /foreshadows 的条目（fm 字段 + 足迹）。 */
export interface Foreshadow {
  file: string
  标题: string
  状态: string
  埋设章号: number | null
  回收章号: number | null
  重要性: string
  关联词: string[]
  摘要: string
  足迹: ForeshadowTrail | null
}
