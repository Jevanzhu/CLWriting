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

export function readOutlineLeads(bookRoot: string): string[] {
  const outlinePath = join(bookRoot, '工作区', '细纲.md')
  if (!existsSync(outlinePath)) return []
  const r = readFile(outlinePath)
  if (!r.ok) return []
  const v = parseFlat(r.fmRaw).get('推进')
  if (typeof v === 'string' && v.trim()) return [v.trim()]
  if (Array.isArray(v)) {
    return v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
  }
  return []
}