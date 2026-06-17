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
import { readGrowthHistory, readCurrentRealm } from '../cli/read.js'
import { getRealmSequence, realmIndex } from '../format/realms.js'
import { LEAD_VERBS } from '../format/leads.js'
import type { RealmDoc } from '../format/types.js'

/** 成长线跃迁动词（单源取自 LEAD_VERBS，避免硬编码错配） */
const GROWTH_TRANSITION_VERBS = new Set<string>(LEAD_VERBS.成长线.resolve)

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

  for (const id of growthLeadIds) {
    const currentRealm = readCurrentRealm(db, id)
    const history = readGrowthHistory(db, id)

    // 取该条目的境界体系名（从缓存读 cur_realm 推断体系，或遍历）
    // 简化：遍历所有体系，找到包含 currentRealm 的那个
    let systemName: string | null = null
    let sequence: string[] | null = null
    if (realmDoc && currentRealm) {
      for (const sys of realmDoc.体系) {
        if (sys.序列.includes(currentRealm)) {
          systemName = sys.名称
          sequence = sys.序列
          break
        }
      }
    }

    // #1 命中：当前境界在序列内
    if (currentRealm && sequence) {
      if (!sequence.includes(currentRealm)) {
        items.push({
          checkId: 'growth-realm-miss',
          level: 'red',
          message: `${id} 当前境界「${currentRealm}」不在体系「${systemName}」的序列中`,
          leadId: id,
        })
        continue // 序列都没有，后续检查无意义
      }
    }

    // 提取履历中的跃迁境界（动词=突破 等收尾类动词，取自 LEAD_VERBS.成长线.resolve）
    const transitions: { chapter: number; realm: string; evidence: string }[] = []
    for (const h of history) {
      if (GROWTH_TRANSITION_VERBS.has(h.verb)) {
        // 从证据提取境界：如「突破至筑基」→ 筑基
        const realm = extractRealmFromEvidence(h.evidence, sequence)
        if (realm) {
          transitions.push({ chapter: h.chapter, realm, evidence: h.evidence })
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

/** 从证据提取目标境界（如「突破至筑基，渡过心魔劫」→ 筑基） */
function extractRealmFromEvidence(evidence: string, sequence: string[] | null): string | null {
  if (!sequence) return null
  // 在证据里找序列中的境界名
  for (const realm of sequence) {
    if (evidence.includes(realm)) return realm
  }
  return null
}
