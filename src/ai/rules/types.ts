/**
 * WritingRule —— 约束规则真相源（A2 三源归一）。
 *
 * 同一份规则两个出口：
 * - toPrompt() → 注入 system prompt（写稿前告知 AI 约束）
 * - check()    → 检验产出违规（错误信息 = 修复指令，可直接回灌重写 prompt）
 *
 * 设计要点：
 * - 级别分红/黄——红项卡流程（evaluateRetry 打回重写），黄项提示不卡（B2 回流）
 * - tasks 挂载 TaskSpec.name——写稿查 AI 味、审稿不查，由挂载关系表达
 * - check() 是确定性检测（字符串/统计），不调 AI——零成本零延迟
 * - check(body) 的 body 含 front matter（plot-consistency 需比对 fm）；
 *   只关心正文的文本扫描/统计规则应先经 ruleStripFm 剥离，避免 fm 短行污染统计
 */

import { splitFrontMatter } from '../../format/frontmatter.js'

/** 规则级别：红项卡流程，黄项提示不卡 */
export type RuleLevel = 'red' | 'yellow'

/** 规则执行上下文（书级数据源用） */
export interface RuleContext {
  /** 书库根路径（读条目库等书级数据源；内置静态规则可忽略） */
  bookRoot: string
  /** 章号（情节一致等按章定位的规则用；注入侧 toPrompt 不需要） */
  chapter?: number
}

/** 规则违规项（message 即修复指令，可直接作为重写 prompt 条目） */
export interface RuleViolation {
  /** 规则 ID（trace + 命中统计用） */
  ruleId: string
  /** 级别（黄项不卡流程） */
  level: RuleLevel
  /** 修复指令（祈使句，可直接回灌重写 prompt） */
  message: string
}

/**
 * 写作约束规则——注入与检验共用同一份文案。
 *
 * 注入侧：runSpec 按 tasks 匹配拼接 toPrompt() 到 system prompt。
 * 检验侧：collectRuleViolations 遍历适用规则 check()，违规落反馈。
 */
export interface WritingRule {
  /** 规则 ID（全局唯一，trace + 统计用） */
  readonly id: string
  /** 级别 */
  readonly level: RuleLevel
  /** 挂载的任务名（TaskSpec.name）；只有匹配的任务才注入 + 检验 */
  readonly tasks: readonly string[]
  /** 注入 system prompt 的约束文本（null = 不注入） */
  toPrompt(ctx: RuleContext): string | null
  /** 检验违规项（空数组 = 无违规）；body 含 fm，正文型规则用 ruleStripFm 剥离 */
  check(body: string, ctx: RuleContext): RuleViolation[]
}

/** 剥离 front matter 取正文（正文型规则入参预处理；plot-consistency 等需要 fm 的规则不用） */
export function ruleStripFm(content: string): string {
  const split = splitFrontMatter(content)
  return split ? split.body : content
}
