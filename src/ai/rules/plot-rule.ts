/**
 * 情节一致规则（A3）—— 草稿 front matter 与章纲枚举字段偏差检测。
 *
 * 纯规则层：只比对草稿 fm 与章纲 fm 的枚举字段（钩子类型/情绪定位/场景）。
 * 正文要点的语义覆盖留给审稿 AI，不在本规则范围。
 *
 * 数据源：
 * - 章纲：大纲/章纲/<章号>-<标题>.md → readChapterDir → 按 ctx.chapter 过滤
 * - 草稿 fm：body 参数（self-heal assembleChapter 产出 = fm + 正文）
 *
 * 短篇无 ChapterMeta 章纲（readChapterDir 返回空数组）→ 自然跳过。
 */
import { join } from 'node:path'
import { readChapterDir } from '../../format/chapters.js'
import { splitFrontMatter, parseFlat } from '../../format/frontmatter.js'
import type { WritingRule, RuleViolation, RuleContext } from './types.js'

/** 通用约束文案（不依赖章纲存在，注入侧用） */
const PLOT_CONSISTENCY_PROMPT =
  '情节一致：本章细纲声明的场景类型/情绪定位/钩子类型必须写入正文 front matter 对应字段，不得偏离章纲声明。'

/** 比对的枚举字段清单（章纲 ChapterMeta 与草稿 fm 共有） */
const COMPARE_FIELDS = ['钩子类型', '情绪定位', '场景'] as const

/** 情节一致规则（黄级：提示不卡流程） */
export const plotConsistencyRule: WritingRule = {
  id: 'plot-consistency',
  level: 'yellow',
  tasks: ['self-heal', 'spawn-write', 'rewrite'],

  toPrompt(): string {
    return PLOT_CONSISTENCY_PROMPT
  },

  check(body: string, ctx: RuleContext): RuleViolation[] {
    // 无章号 → 无法定位章纲，静默跳过
    if (ctx.chapter === undefined) return []

    // 读章纲目录，按章号过滤
    const { chapters } = readChapterDir(join(ctx.bookRoot, '大纲', '章纲'))
    const outline = chapters.find((c) => c.章号 === ctx.chapter)
    if (!outline) return [] // 无对应章纲，静默跳过

    // 从 body 拆出草稿 front matter（body = fm + 正文）
    const split = splitFrontMatter(body)
    if (split === null) return [] // body 无 front matter，无法比对
    const draftFm = parseFlat(split.fmRaw)

    // 逐字段比对：草稿 fm 与章纲声明不一致 → 报黄
    const violations: RuleViolation[] = []
    const outlineRecord = outline as unknown as Record<string, unknown>
    for (const field of COMPARE_FIELDS) {
      const draftVal = draftFm.get(field)
      if (draftVal === undefined) continue // 草稿 fm 缺该字段 → 跳过（无法比对）

      const outlineVal = outlineRecord[field]
      if (outlineVal === undefined) continue // 章纲无该字段声明 → 跳过

      if (String(draftVal) !== String(outlineVal)) {
        violations.push({
          ruleId: 'plot-consistency',
          level: 'yellow' as const,
          message: `${field}偏离章纲声明：章纲=${outlineVal}，草稿=${draftVal}——请按章纲声明修正 front matter`,
        })
      }
    }

    return violations
  },
}
