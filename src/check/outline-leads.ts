/**
 * 大纲推进声明读取 —— 账本左侧（声明侧）数据源。
 * （P1-8 架构下沉：从 src/process/materials.ts 移入 check 域，机检账本数据源归位）
 *
 * `工作区/细纲.md` front matter 的「推进」字段是结构化声明（本章计划推进的账本编号）。
 * 单值 `推进: 成长线-001` → ['成长线-001']；多值 `推进: [成长线-001, 设定线-001]` → [...]。
 * 缺省/无细纲/无 front matter → []（无声明，两端闭合左侧空）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, parseFlat } from '../format/frontmatter.js'

/**
 * 读细纲的账本推进声明。
 * @param forChapter 被检章号（V-P2-14）：细纲 front matter 自带章号且与被检章不一致时
 *   返回 []（声明侧置空，不比对）——细纲是「当前章」覆盖写单文件，树红点聚合复检
 *   旧草稿时，旧章正文对上新章声明会批量误报 lead-declared-not-done。
 *   旧书细纲无章号字段 → 宽容沿用（视为属于被检章）。
 *   R69-2（十七轮）：「置空不比对」的原意是声明未知时跳过两端闭合，但 [] 与「明确
 *   未声明」不可区分——调用方要区分须改用 outlineDeclarationForChapter（known 三态）。
 */
export function readOutlineLeads(bookRoot: string, forChapter?: number): string[] {
  const d = outlineDeclarationForChapter(bookRoot, forChapter)
  return d.known ? d.leads : []
}

/**
 * R69-2（十七轮）：细纲声明侧三态读取——区分「声明未知」与「明确未声明」。
 * - known:true + leads —— 细纲属于被检章（或无章号宽容沿用/无细纲），leads 为声明值
 *   （可为空数组 = 明确未声明任何推进，两端闭合照常比对）。
 * - known:false —— 细纲自带章号且 ≠ 被检章：本章声明未知（细纲是覆盖写单文件，
 *   批量连写 batchSize≥2 时细纲恒@首章、其余章推进落归档），此时两端闭合的
 *   done-not-declared 方向不可判定——调用方应跳过闭合比对（此前 [] 被当「未声明」，
 *   归档章的实际推进全部误报红并经 LEAD_GATE 硬阻断批量定稿）。
 */
export function outlineDeclarationForChapter(
  bookRoot: string,
  forChapter?: number,
): { known: boolean; leads: string[] } {
  const outlinePath = join(bookRoot, '工作区', '细纲.md')
  if (!existsSync(outlinePath)) return { known: true, leads: [] }
  // R70-15（十八轮）：读失败（瞬态占用/IO 错误）≠「明确未声明」——按声明未知处理跳过
  // 两端闭合，否则瞬态错误会产 lead-done-not-declared 假红并经 LEAD_GATE 硬阻断定稿
  //（把瞬态故障当作者过错）。文件不存在仍属「已细纲、无声明」已知态。
  const r = readFile(outlinePath)
  if (!r.ok) return { known: false, leads: [] }
  const fm = parseFlat(r.fmRaw)
  if (forChapter !== undefined) {
    const outlineChapter = Number(fm.get('章号'))
    if (Number.isInteger(outlineChapter) && outlineChapter > 0 && outlineChapter !== forChapter) {
      return { known: false, leads: [] }
    }
  }
  const v = fm.get('推进')
  if (typeof v === 'string' && v.trim()) return { known: true, leads: [v.trim()] }
  if (Array.isArray(v)) {
    return {
      known: true,
      leads: v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()),
    }
  }
  return { known: true, leads: [] }
}