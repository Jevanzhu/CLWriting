// R59 清偿批（R57-F-2）：三审意见 / 机检命中列表的 v-for 稳定键构造单源。
//
// 两类列表条目均无条目级唯一 id：
// - ReviewIssueFE（三审意见）是 AI 产出的内容条目，无 id 字段；
// - CheckItem 的 checkId 是检查器级 id（同一检查器的全部命中同 id，如 banned-word
//   多处命中各自成条目）——直接拿 checkId 作键在多条命中时必撞 Vue 重复键。
// 位置索引键（'b'+i）在整体替换型渲染下无实伤，但违库内稳定键惯例。按评审建议以
// 内容字段最小组合作稳定键；完全同内容的条目按出现序追加 #n 消歧（同内容条目互换
// 位置渲染无差别，键序漂移无实害）。列表为整体替换型渲染（run/loadEnvelope 整体
// 落位），键只要求「同内容稳定、异内容互异」，不要求跨会话持久。
// 分隔符用 \u0000：对齐 check.ts fpKey 的 R49-27 口径（可打印分隔符在字段含该字符
// 时产生拼接歧义）。
import type { ReviewIssueFE } from '../api/review'
import type { CheckItem } from '../api/check'

/** 三审意见条目的键基串：视角|位置|问题|证据|建议（内容字段最小组合）。 */
export function reviewIssueKeyBase(it: ReviewIssueFE): string {
  return [it.lens, it.location, it.issue, it.evidence.join('\u0001'), it.fix].join('\u0000')
}

/** 机检命中条目的键基串：checkId|消息|leadId|章号——checkId 检查器级非条目唯一，须叠内容消歧。 */
export function checkItemKeyBase(it: CheckItem): string {
  return [it.checkId, it.message, it.leadId ?? '', it.chapter ?? ''].join('\u0000')
}

/** 基串列表 → v-for 键列表：同基串第 n 次出现（n≥2）追加 `#n`；异基串键互异，
 *  同基串键按出现序稳定（distinct 条目重排后各自键不变）。 */
export function contentStableKeys(bases: string[]): string[] {
  const seen = new Map<string, number>()
  return bases.map((b) => {
    const n = (seen.get(b) ?? 0) + 1
    seen.set(b, n)
    return n === 1 ? b : `${b}#${n}`
  })
}
