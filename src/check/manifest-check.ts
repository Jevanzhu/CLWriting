/**
 * 单篇清单形式检（机检层）。
 *
 * 与设定收尾审分工：
 * - 机检挡**形式**（反转线索 ≥3 铺垫、伏笔回收闭合标记）—— 本文件
 * - 三审查**语义**（铺垫是否真支撑反转、伏笔是否真回收）—— review/contract.ts payoff 视角
 *
 * 复用 CheckSectionResult 契约，接入 runAllChecks 短篇分支。
 */

import type { CheckSectionResult, CheckItem } from './types.js'
import type { PieceList } from '../format/types.js'

// 清单形式检规则表/阈值——导出供机检代次哈希收编（改一处代次自动变，
// 旧缓存整代表失效；消费面见 checker-generation.ts）。

/** 反转线索表最少有效铺垫点数。 */
export const MANIFEST_MIN_SETUPS = 3
/** 情绪曲线最少有效段数。 */
export const EMOTION_CURVE_MIN_SEGMENTS = 5
/** 情绪强度合法区间（闭区间）。 */
export const EMOTION_STRENGTH_MIN = 1
export const EMOTION_STRENGTH_MAX = 10
/** 情绪曲线峰值低阈：最高强度低于此值报黄。 */
export const EMOTION_PEAK_MIN = 8
/** 清单占位词表（视为未填写）。 */
export const PIECE_LIST_PLACEHOLDERS = ['待定', '待补', '（待补）']

/**
 * 清单形式检：反转线索表形式 + 伏笔回收闭合。
 * - 反转线索表核心反转为空 / 铺垫点 <3 → 报黄（机检形式，提示补；语义真伪归三审）
 * - 伏笔回收有「未回收」标记 → 报黄（清单显式标记的弃坑；未登记的弃坑归三审语义发现）
 */
export function checkPieceListForm(list: PieceList): CheckSectionResult {
  const items: CheckItem[] = []

  // 反转线索表形式
  const lead = list.反转线索表
  if (isPlaceholder(lead.核心反转)) {
    items.push({
      checkId: 'manifest-no-reversal',
      level: 'yellow',
      message: '清单反转线索表缺少核心反转',
    })
  }
  const realSetups = lead.铺垫点.filter((p) => !isPlaceholder(p.位置) && !isPlaceholder(p.内容))
  if (realSetups.length < MANIFEST_MIN_SETUPS) {
    items.push({
      checkId: 'manifest-setup-short',
      level: 'yellow',
      message: `反转线索表有效铺垫点仅 ${realSetups.length} 处（<${MANIFEST_MIN_SETUPS}），反转信息差可能不成立`,
    })
  }

  // 情绪曲线形式：五段都要有情绪与 1-10 强度；语义达峰归情绪反转审。
  const curve = list.情绪曲线 ?? []
  const realCurve = curve.filter((p) => {
    const noteIsPlaceholder = p.说明 !== undefined && isPlaceholder(p.说明)
    return !isPlaceholder(p.段落) && !isPlaceholder(p.情绪) && !noteIsPlaceholder
  })
  if (realCurve.length < EMOTION_CURVE_MIN_SEGMENTS) {
    items.push({
      checkId: 'emotion-curve-short',
      level: 'yellow',
      message: `情绪曲线有效段仅 ${realCurve.length} 段（<${EMOTION_CURVE_MIN_SEGMENTS}），无法核对单章情绪爆破`,
    })
  }
  const invalidStrength = curve.filter(
    (p) => !Number.isFinite(p.强度) || p.强度 < EMOTION_STRENGTH_MIN || p.强度 > EMOTION_STRENGTH_MAX,
  )
  if (invalidStrength.length > 0) {
    items.push({
      checkId: 'emotion-curve-strength',
      level: 'yellow',
      message: `情绪曲线有 ${invalidStrength.length} 段强度不在 1-10`,
    })
  }
  if (realCurve.length > 0 && !realCurve.some((p) => p.段落.includes('反转'))) {
    items.push({
      checkId: 'emotion-curve-no-reversal',
      level: 'yellow',
      message: '情绪曲线缺少反转段，情绪峰值无锚点',
    })
  }
  // realCurve 混入 NaN/Infinity 强度时 Math.max 得 NaN，`NaN < 8`
  // 恒 false → emotion-curve-peak-low 漏判。计算前过滤非有限值：非 1-10 强度（含非
  // 有限）已由上方 emotion-curve-strength 黄项兜底回报，本处只管「有效强度里的峰值」；
  // 过滤后为空 → Math.max 得 -Infinity < 8 照报（fail-noisy：曲线全坏不静默放行）。
  const finiteStrengths = realCurve.map((p) => p.强度).filter((s) => Number.isFinite(s))
  if (realCurve.length > 0 && Math.max(...finiteStrengths) < EMOTION_PEAK_MIN) {
    items.push({
      checkId: 'emotion-curve-peak-low',
      level: 'yellow',
      message: `情绪曲线最高强度低于 ${EMOTION_PEAK_MIN}/${EMOTION_STRENGTH_MAX}，单章爆破力可能不足`,
    })
  }

  // 伏笔回收闭合（显式「未回收」标记）
  const unresolved = list.伏笔回收.filter((e) => e.未回收)
  if (unresolved.length > 0) {
    items.push({
      checkId: 'manifest-payoff-open',
      level: 'yellow',
      message: `伏笔回收有 ${unresolved.length} 处显式标记未回收（${unresolved
        .map((e) => e.伏笔)
        .slice(0, 3)
        .join('、')}）`,
    })
  }

  return { name: '清单形式检', items }
}

function isPlaceholder(value: string | undefined): boolean {
  const v = (value ?? '').trim()
  return v === '' || PIECE_LIST_PLACEHOLDERS.includes(v)
}
