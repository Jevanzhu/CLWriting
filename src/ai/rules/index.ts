/**
 * 规则注册表 + 注入/检验工具函数（A2）。
 *
 * 注入侧：runSpec 调 rulesToPrompt() 拼接约束到 system prompt。
 * 检验侧：collectRuleViolations() 跑全部适用规则 check()（B2 接入自愈循环）。
 */
import type { WritingRule, RuleViolation, RuleContext } from './types.js'
import { aiClicheRule } from './builtin.js'
import { loadAiFlavorRule } from './book-rules.js'

export type { WritingRule, RuleViolation, RuleLevel, RuleContext } from './types.js'
export { aiClicheRule } from './builtin.js'
export { loadAiFlavorRule } from './book-rules.js'

/**
 * 收集任务适用的全部规则（内置静态 + 书级动态）。
 * bookRoot 为空时只返回内置静态规则。
 */
export function applicableRules(task: string, bookRoot?: string): WritingRule[] {
  const all = bookRoot
    ? [aiClicheRule, loadAiFlavorRule(bookRoot)]
    : [aiClicheRule]
  return all.filter((r) => r.tasks.includes(task))
}

/**
 * 拼接适用规则的 toPrompt() → 注入 system prompt 的约束后缀。
 * 无适用规则或全部返回 null 时返回空串（不污染 system prompt）。
 */
export function rulesToPrompt(task: string, bookRoot?: string): string {
  const rules = applicableRules(task, bookRoot)
  const ctx: RuleContext = { bookRoot: bookRoot ?? '' }
  const lines = rules
    .map((r) => r.toPrompt(ctx))
    .filter((t): t is string => t != null)
  return lines.length ? '\n\n## 写作约束\n' + lines.map((l) => `- ${l}`).join('\n') : ''
}

/**
 * 跑全部适用规则 check() → 汇总违规项。
 * 违规项 message 可直接作为重写 prompt 条目（B2 多维反馈回流）。
 */
export function collectRuleViolations(body: string, task: string, bookRoot: string): RuleViolation[] {
  const ctx: RuleContext = { bookRoot }
  return applicableRules(task, bookRoot).flatMap((r) => r.check(body, ctx))
}
