/**
 * 规则注册表 + 注入/检验工具函数（A2）。
 *
 * 注入侧：runSpec 调 rulesToPrompt() 拼接约束到 system prompt。
 * 检验侧：collectRuleViolations() 跑全部适用规则 check()（B2 接入自愈循环）。
 */
import type { WritingRule, RuleViolation, RuleContext } from './types.js'
import { aiClicheRule } from './builtin.js'
import { loadAiFlavorRule } from './book-rules.js'
import { styleConsistencyRule } from './style-rule.js'
import { settingConsistencyRule } from './setting-rule.js'
import { plotConsistencyRule } from './plot-rule.js'
import { topRuleHits } from '../rule-hits.js'

export type { WritingRule, RuleViolation, RuleLevel, RuleContext } from './types.js'
export { aiClicheRule } from './builtin.js'
export { loadAiFlavorRule } from './book-rules.js'
export { styleConsistencyRule } from './style-rule.js'
export { settingConsistencyRule } from './setting-rule.js'
export { plotConsistencyRule } from './plot-rule.js'

/** 内置静态规则（不依赖 bookRoot 预加载，check/toPrompt 内部实时读） */
const STATIC_RULES: readonly WritingRule[] = [
  aiClicheRule,
  styleConsistencyRule,
  settingConsistencyRule,
  plotConsistencyRule,
]

/** 规则 ID → 中文标签（B4 前置注入用） */
const RULE_LABEL: Record<string, string> = {
  'ai-cliche': 'AI高频套话',
  'ai-flavor-words': 'AI味词',
  'style-consistency': '文风偏离',
  'setting-consistency': '设定偏离',
  'plot-consistency': '情节偏离',
}

/**
 * 收集任务适用的全部规则（内置静态 + 书级动态）。
 * bookRoot 为空时只返回内置静态规则。
 */
export function applicableRules(task: string, bookRoot?: string): WritingRule[] {
  const all = bookRoot
    ? [...STATIC_RULES, loadAiFlavorRule(bookRoot)]
    : [...STATIC_RULES]
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
  const constraintText = lines.length ? '\n\n## 写作约束\n' + lines.map((l) => `- ${l}`).join('\n') : ''

  // B4：高频违规前置注入（读该书 Top-N 命中生成预防指令；无统计零注入，行为同现状）
  const preventionText = bookRoot ? buildPreventionText(bookRoot) : ''
  return constraintText + preventionText
}

/** B4 前置注入：Top-3 高频违规 → 预防指令（无命中返回空串） */
function buildPreventionText(bookRoot: string): string {
  const top = topRuleHits(bookRoot, 3)
  if (!top.length) return ''
  const items = top.map((h) => {
    const label = RULE_LABEL[h.ruleId] ?? h.ruleId
    const hint = h.recentMessages[0] ?? '初稿即注意'
    return `- ${label} 已被检出 ${h.hits} 次——${hint}`
  })
  return '\n\n## 本书近期常见问题（规则命中提示）\n' + items.join('\n')
}

/**
 * Y-2（第五十七轮）：rulesToPrompt 注入段的源文件清单（相对书根）——铁律①
 * 「模型可见⟺已记录」登记通道。动态源两个：条目库 AI味标签禁词（经
 * loadAiFlavorRule 注入，空词表不入 prompt 不登记——Q-5「空段不登记」口径）
 * 与 .cache/rule-hits.json（Top-N 预防指令，无命中不登记）。内置静态规则内容
 * 编译进代码本身可考，无需文件登记。与 rulesToPrompt 同读同判，供 runSpec
 * 并入 promptFiles（与 user prompt 材料同通道落 llm/call 事件）。
 */
export function rulesPromptFiles(task: string, bookRoot?: string): string[] {
  if (!bookRoot) return []
  const files: string[] = []
  if (applicableRules(task, bookRoot).some((r) => r.id === 'ai-flavor-words')) {
    if (loadAiFlavorRule(bookRoot).toPrompt({ bookRoot }) != null) {
      files.push('文风/条目/禁词')
    }
  }
  if (topRuleHits(bookRoot, 3).length > 0) {
    files.push('.cache/rule-hits.json')
  }
  return files
}

/**
 * 跑全部适用规则 check() → 汇总违规项。
 * 违规项 message 可直接作为重写 prompt 条目（B2 多维反馈回流）。
 * chapter 仅供情节一致等按章定位的规则（A3），不传则跳过此类规则。
 */
export function collectRuleViolations(body: string, task: string, bookRoot: string, chapter?: number): RuleViolation[] {
  const ctx: RuleContext = { bookRoot, chapter }
  return applicableRules(task, bookRoot).flatMap((r) => r.check(body, ctx))
}
