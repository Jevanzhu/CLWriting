/**
 * 成长线境界语义校验 —— 依据 #6 + #10 第 2 节项 2（🔴 红）。
 *
 * 仅启用成长线时跑。零 token 读境界体系序列 + 履历，校验：
 * 1. 命中：当前境界 + 履历境界须在序列内
 * 2. 单调性：履历各跃迁境界索引不递减
 * 3. 跨度：相邻跃迁索引差 ≤ realm_span_max
 * 4. 证据：每次跃迁有章号 + 章内证据
 */

import type { DatabaseSync } from 'node:sqlite'
import type { CheckSectionResult, CheckItem } from './types.js'
import { readGrowthHistory, readCurrentRealm } from '../format/read.js'
import { extractExactRealmFromEvidence, realmIndex } from '../format/realms.js'
import { LEAD_VERBS } from '../format/leads.js'
import type { RealmDoc } from '../format/types.js'

/** 成长线跃迁动词（单源取自 LEAD_VERBS，避免硬编码错配） */
const GROWTH_TRANSITION_VERBS = new Set<string>(LEAD_VERBS.成长线.resolve)
const GROWTH_VALID_VERBS = new Set<string>([
  ...LEAD_VERBS.成长线.open,
  ...LEAD_VERBS.成长线.advance,
  ...LEAD_VERBS.成长线.resolve,
  ...LEAD_VERBS.成长线.drop,
])

/**
 * 成长线语义校验。
 * @param db 缓存
 * @param realmDoc 境界体系（#6）
 * @param growthLeadIds 成长线条目 id 列表
 * @param realmSpanMax 跃迁跨度上限（#9 growth.realm_span_max）
 */
export function checkGrowth(
  db: DatabaseSync,
  realmDoc: RealmDoc | null,
  growthLeadIds: string[],
  realmSpanMax: number,
): CheckSectionResult {
  const items: CheckItem[] = []

  if (growthLeadIds.length === 0) {
    return { name: '成长线境界语义', items }
  }

  if (!realmDoc || realmDoc.体系.length === 0) {
    items.push({
      checkId: 'growth-realm-sequence-missing',
      // R36-3（三十六轮）：维持 red——境界体系解析失败 = 序列不可用（sequence 全程
      // null），realm-miss/regress/span-exceed 全部静默跳过，成长线红闸整体失效；
      // red 打回自动写章迫使作者修复（fail-closed，与 R29-6「体系缺失红项语义不同，
      // 维持红」口径一致）。文案改为如实描述：文件可能明明有内容（如 CRLF 换行/格式
      // 异常），旧文案「没有可解析的 front matter」误导排障。
      level: 'red',
      message: '已启用成长线，但未解析出有效的境界体系（设定/境界体系.md 缺少「体系/序列」，或 front matter 内容/换行格式异常），境界跳跃/回退检测未生效。',
    })
  }

  for (const id of growthLeadIds) {
    const currentRealm = readCurrentRealm(db, id)
    const history = readGrowthHistory(db, id)

    // 取该条目的境界体系名（从缓存读 cur_realm 推断体系，或遍历）
    // R73-30（二十一轮）：多体系前缀重叠（炼气/炼气期 两体系并存）时此前取首个命中
    // 体系，「炼气一层」会错挂到「炼气」系而真实体系是「炼气期」系，后续跃迁全按错
    // 基准判红。改全序列打分消歧：精确命中 > 最长前缀匹配（任一方向，V-P2-17 语义
    // 不变），得分同序先到先得。
    let sequence: string[] | null = null
    if (realmDoc && currentRealm) {
      let bestScore = 0
      for (const sys of realmDoc.体系) {
        let score = 0
        if (sys.序列.includes(currentRealm)) {
          // V-P2-17：精确命中最高优先
          score = Number.MAX_SAFE_INTEGER
        } else {
          // V-P2-17：前缀匹配（任一方向）仍认，但以匹配长度为强度——「炼气一层」对
          // 「炼气期」系（前缀「炼气」长 2）与「炼气」系（全等前缀长 2）同分时先到
          // 先得；「炼气期一层」对「炼气期」系前缀长 3 > 「炼气」系长 2，正确消歧
          let bestPrefix = 0
          for (const realm of sys.序列) {
            if (currentRealm.startsWith(realm) && realm.length > bestPrefix) bestPrefix = realm.length
            else if (realm.startsWith(currentRealm) && currentRealm.length > bestPrefix) bestPrefix = currentRealm.length
          }
          score = bestPrefix
        }
        if (score > bestScore) {
          bestScore = score
          sequence = sys.序列
        }
      }
    }

    // R29-6（二十九轮）：缺「当前境界」红→黄——该条目在新书/未设境界的成长线上恒真，
    // 红项会每章把自动写章打回（红项驱动自愈循环，成长线无当前境界不阻断本章叙事）；
    // 降黄后作者面板仍可见（fail-noisy 保留），只有真实的跃迁类红项（回退/超跨/不在
    // 序列）继续打回。体系缺失红项（growth-realm-sequence-missing）语义不同，维持红。
    if (!currentRealm && realmDoc && realmDoc.体系.length > 0) {
      items.push({
        checkId: 'growth-current-realm-missing',
        level: 'yellow',
        message: `${id} 缺少当前境界，无法确定应使用哪套境界序列，成长线跃迁检测未完整生效。`,
        leadId: id,
      })
      continue
    }

    // #1 命中：当前境界在序列内
    if (currentRealm && realmDoc && realmDoc.体系.length > 0 && !sequence) {
      items.push({
        checkId: 'growth-realm-miss',
        level: 'red',
        message: `${id} 当前境界「${currentRealm}」不在任何境界体系序列中`,
        leadId: id,
      })
      continue // 当前境界找不到体系，后续检查无意义
    }

    // 提取履历中的跃迁境界（动词=突破 等收尾类动词，取自 LEAD_VERBS.成长线.resolve）
    const transitions: { chapter: number; realm: string; evidence: string }[] = []
    for (const h of history) {
      if (!GROWTH_VALID_VERBS.has(h.verb)) {
        items.push({
          checkId: 'growth-verb-invalid',
          level: 'yellow',
          message: `${id} 第${h.chapter}章履历动词「${h.verb}」不是成长线合法动词（${[...GROWTH_VALID_VERBS].join(' / ')}），该条不会计入境界跃迁。`,
          leadId: id,
          chapter: h.chapter,
        })
      }
      if (GROWTH_TRANSITION_VERBS.has(h.verb) && sequence) {
        // R35-3（三十五轮）：回填条目不入跃迁序列——回填 seq 必然靠后（后补录），按
        // seq 序做单调性/跨度判定会把后补的早期低阶跃迁误判成 growth-regress /
        // growth-span-exceed 假红（回退红项驱动自愈打回没问题的正文）。对齐 leads.ts
        // 账本三检的 `!entry.回填` 豁免口径（动词合法性黄项不豁免，见上方）。
        if (h.backfill) continue
        // 从证据提取境界：如「突破至筑基」→ 筑基
        const realm = extractExactRealmFromEvidence(h.evidence, sequence)
        if (realm) {
          transitions.push({ chapter: h.chapter, realm, evidence: h.evidence })
        } else {
          // R62-2：提取失败不再静默跳过——该条对 growth-regress/span-exceed/realm-miss
          // 整体失明且作者得不到「证据缺境界名」任何信号；与 growth-verb-invalid 推黄同口径
          items.push({
            checkId: 'growth-evidence-no-realm',
            level: 'yellow',
            message: `${id} 第${h.chapter}章履历证据「${h.evidence}」中提取不到序列内的确切境界名，该条未计入境界跃迁（升阶/跨度检查对其漏检）。`,
            leadId: id,
            chapter: h.chapter,
          })
        }
      }
    }

    if (sequence && transitions.length > 0) {
      let prevIdx = -1
      for (const t of transitions) {
        const idx = realmIndex(sequence, t.realm)

        // #1 命中：跃迁境界在序列内
        if (idx === -1) {
          items.push({
            checkId: 'growth-realm-miss',
            level: 'red',
            message: `${id} 第${t.chapter}章跃迁至「${t.realm}」，不在序列中`,
            leadId: id,
            chapter: t.chapter,
          })
          continue
        }

        // #2 单调性：不递减
        if (prevIdx !== -1 && idx < prevIdx) {
          items.push({
            checkId: 'growth-regress',
            level: 'red',
            message: `${id} 境界从「${sequence[prevIdx]}」回退到「${t.realm}」（第${t.chapter}章）`,
            leadId: id,
            chapter: t.chapter,
          })
        }

        // #3 跨度：索引差 ≤ realmSpanMax
        if (prevIdx !== -1 && idx - prevIdx > realmSpanMax) {
          items.push({
            checkId: 'growth-span-exceed',
            level: 'red',
            message: `${id} 第${t.chapter}章从「${sequence[prevIdx]}」跃迁到「${t.realm}」，跨${idx - prevIdx}级超上限${realmSpanMax}`,
            leadId: id,
            chapter: t.chapter,
          })
        }

        prevIdx = idx
      }
    }
  }

  return { name: '成长线境界语义', items }
}
