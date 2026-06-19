/**
 * 单篇清单形式检（机检层）—— 依据 M8 #27 第 5 节 + #28 第 3 节分工。
 *
 * 与 #28 设定收尾审分工：
 * - 机检挡**形式**（反转线索 ≥3 铺垫、伏笔回收闭合标记）—— 本文件
 * - 三审查**语义**（铺垫是否真支撑反转、伏笔是否真回收）—— review/contract.ts payoff 视角
 *
 * 复用 CheckSectionResult 契约，接入 runAllChecks 短篇分支。
 */

import type { CheckSectionResult, CheckItem } from './types.js'
import type { PieceList } from '../format/types.js'

/**
 * 清单形式检：反转线索表形式 + 伏笔回收闭合。
 * - 反转线索表核心反转为空 / 铺垫点 <3 → 报黄（机检形式，提示补；语义真伪归三审）
 * - 伏笔回收有「未回收」标记 → 报黄（清单显式标记的弃坑；未登记的弃坑归三审语义发现）
 */
export function checkPieceListForm(list: PieceList): CheckSectionResult {
  const items: CheckItem[] = []

  // 反转线索表形式
  const lead = list.反转线索表
  if (!lead.核心反转) {
    items.push({
      checkId: 'manifest-no-reversal',
      level: 'yellow',
      message: '清单反转线索表缺少核心反转',
    })
  }
  if (lead.铺垫点.length < 3) {
    items.push({
      checkId: 'manifest-setup-short',
      level: 'yellow',
      message: `反转线索表铺垫点仅 ${lead.铺垫点.length} 处（<3），反转信息差可能不成立`,
    })
  }

  // 伏笔回收闭合（显式「未回收」标记）
  const unresolved = list.伏笔回收.filter((e) => e.未回收)
  if (unresolved.length > 0) {
    items.push({
      checkId: 'manifest-payoff-open',
      level: 'yellow',
      message: `伏笔回收有 ${unresolved.length} 处显式标记未回收（${unresolved.map((e) => e.伏笔).slice(0, 3).join('、')}）`,
    })
  }

  return { name: '清单形式检', items }
}
