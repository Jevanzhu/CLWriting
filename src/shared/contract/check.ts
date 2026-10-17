/**
 * 机检回包契约（前端 api/check.ts 与服务端 check 端点共用）。
 *
 * 服务端权威类型 = src/check/types.ts；本文件是跨端同源声明，不得 import 服务端模块
 * （前端构建只收 web-next 子树）。漂移由 check.conformance.ts 的编译期断言钉住。
 */

export type CheckLevel = 'red' | 'yellow'

export interface CheckItem {
  checkId: string
  level: CheckLevel
  message: string
  leadId?: string
  chapter?: number
}

export interface CheckSection {
  name: string
  items: CheckItem[]
}

export interface CheckByproducts {
  leadChanges?: { leadId: string; chapter: number; verb: string; evidence: string }[]
  infoLeakCandidates?: string[]
  newNames?: string[]
  pieceListChecks?: {
    type: 'reversal' | 'payoff'
    subject: string
    location: string
    detail: string
  }[]
}

export interface CheckReport {
  sections: CheckSection[]
  byproducts?: CheckByproducts
}

/** POST /documents/:docId/check 回包。 */
export interface CheckResult {
  ok: true
  report: CheckReport
  hasRed: boolean
  /** 本次按作者误报标记跳过的命中条数（旧服务端缺此字段，消费侧按 0 兜底）。 */
  suppressedCount?: number
}
