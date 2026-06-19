/**
 * 机检基础类型 —— 依据 #10 机检规则 spec。
 *
 * 红/黄两级（#10 第 3 节）：
 * - 红 = 硬卡（自愈打回写稿重写）
 * - 黄 = 提醒（不卡，进三审报告）
 */

/** 检查项级别（#10 第 2 节） */
export type CheckLevel = 'red' | 'yellow'

/** 单条检查结果 */
export interface CheckItem {
  /** 检项编号（#10 第 2 节 #1-11） */
  checkId: string
  /** 红/黄 */
  level: CheckLevel
  /** 人话描述（哪条、哪行、为什么） */
  message: string
  /** 相关账本 id（如有） */
  leadId?: string
  /** 相关章号（如有） */
  chapter?: number
}

/** 一类检查的结果 */
export interface CheckSectionResult {
  /** 检项名 */
  name: string
  /** 该检项的全部命中项 */
  items: CheckItem[]
}

/** 机检报告（全部检项聚合） */
export interface CheckReport {
  sections: CheckSectionResult[]
  /** 顺带产出的料（#10 第 2 节末：账本变动清单等） */
  byproducts?: {
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
}

/** 是否有红项（自愈打回的判定依据，#10 第 6 节） */
export function hasRed(report: CheckReport): boolean {
  return report.sections.some((s) => s.items.some((i) => i.level === 'red'))
}

/** 取全部红项 */
export function getRedItems(report: CheckReport): CheckItem[] {
  const reds: CheckItem[] = []
  for (const s of report.sections) {
    for (const i of s.items) {
      if (i.level === 'red') reds.push(i)
    }
  }
  return reds
}
