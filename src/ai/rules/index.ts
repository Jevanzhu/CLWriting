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
  return rulesPromptParts(task, bookRoot).prompt
}

/** B4 前置注入：Top-3 高频违规 → 预防指令（无命中返回空串） */
function buildPreventionText(items: ReturnType<typeof topRuleHits>): string {
  if (!items.length) return ''
  const lines = items.map((h) => {
    const label = RULE_LABEL[h.ruleId] ?? h.ruleId
    const hint = h.recentMessages[0] ?? '初稿即注意'
    return `- ${label} 已被检出 ${h.hits} 次——${hint}`
  })
  return '\n\n## 本书近期常见问题（规则命中提示）\n' + lines.join('\n')
}

/**
 * A8（五十九轮）：rules 注入文本与登记清单的同源单次派生——此前 rulesToPrompt 与
 * rulesPromptFiles 各自独立读盘（loadAiFlavorRule ×2、topRuleHits ×2），微观窗口内
 * 文件变更可使「注入文本」与「登记清单」撕裂（违反铁律①「模型可见 ⟺ 已记录」的登记
 * 完备性）。runSpec 改调本函数一次读盘同时产出两份；旧两个导出保留为薄壳（其他调用方/
 * 测试口径不变），且同样经本函数派生——任一侧永不脱离单源。
 */
export function rulesPromptParts(task: string, bookRoot?: string): { prompt: string; files: string[] } {
  const rules = applicableRules(task, bookRoot)
  const ctx: RuleContext = { bookRoot: bookRoot ?? '' }
  // 单次 toPrompt 派生：注入行与「AI味词表非空」登记判据同源（规则 id ↔ 文本一一对应）
  const entries = rules.map((r) => ({ id: r.id, text: r.toPrompt(ctx) }))
  const lines = entries.filter((e): e is { id: string; text: string } => e.text != null)
  const constraintText = lines.length ? '\n\n## 写作约束\n' + lines.map((l) => `- ${l.text}`).join('\n') : ''

  // B4：高频违规前置注入（读该书 Top-N 命中生成预防指令；无统计零注入，行为同现状）
  const top = bookRoot ? topRuleHits(bookRoot, 3) : []
  const preventionText = buildPreventionText(top)

  // Y-2（第五十七轮）：注入段源文件清单——与上方注入同一次读盘派生（A8 单源）：
  // AI味标签禁词（经 loadAiFlavorRule 注入，空词表不入 prompt 不登记——Q-5「空段不登记」）
  // 与 .cache/rule-hits.json（Top-N 预防指令，无命中不登记）。内置静态规则内容编译进
  // 代码本身可考，无需文件登记
  const files: string[] = []
  if (lines.some((l) => l.id === 'ai-flavor-words')) files.push('文风/条目/禁词')
  if (top.length > 0) files.push('.cache/rule-hits.json')
  return { prompt: constraintText + preventionText, files }
}

/**
 * Y-2（第五十七轮）：rulesToPrompt 注入段的源文件清单（相对书根）——铁律①
 * 「模型可见⟺已记录」登记通道。A8（五十九轮）：改经 rulesPromptParts 单源派生，
 * 与注入文本同一批读盘结果，不再独立二次读盘。
 */
export function rulesPromptFiles(task: string, bookRoot?: string): string[] {
  return rulesPromptParts(task, bookRoot).files
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
