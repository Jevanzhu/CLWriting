/**
 * 风格一致规则（A3 软约束三项之三）。
 *
 * 实时读已冻结的风格基线（文风/基线.json），对比当前正文的 7 维文风指纹。
 * 注入侧：告知 AI 贴近基线；检验侧：任一维偏离超 40% 报黄（提示不卡流程）。
 *
 * 设计要点：
 * - 静态规则对象（方案 A），check 内部实时读基线（不缓存——基线可能写稿中途冻结）
 * - 无基线静默跳过（toPrompt 返回 null、check 返回空数组），不报错不卡流程
 * - 6 个数值维逐项对比 baseline.overall，偏离超 40% 报黄
 * - summaryEnding 为布尔维度：基线 false 但正文 true 报偏离
 * - 对话标签占比保护：无对话行（_dialogueLines===0）时跳过 dialogueTagRatio 维
 */
import type { WritingRule, RuleViolation } from './types.js'
import { readBaseline, readIronRules, computeFullStats } from '../../metrics/style.js'
import { styleRemedy } from './style-remedy.js'

/** 偏离阈值：偏离超此比例报黄（40%） */
const DEVIATION_THRESHOLD = 0.4

/** 数值维配置：名称 + 当前值 + 基线值 + 格式化 + 建议 */
interface NumericDim {
  name: string
  current: number
  ref: number
  fmt: (v: number) => string
  advice: string
}

/** 百分比格式化（0-1 → XX%） */
function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

/** 偏离百分比（ref===0 且 cur>0 时返回 Infinity，避免除零） */
function deviationPct(cur: number, ref: number): number {
  if (ref === 0) return cur > 0 ? Infinity : 0
  return Math.abs(cur - ref) / Math.abs(ref)
}

/** 构建数值维偏离 message（格式：维名 当前值 偏离基线 基线值（偏高/偏低 XX%），{证据修复建议}） */
function dimMessage(dim: NumericDim, body: string): string {
  const dev = deviationPct(dim.current, dim.ref)
  const direction = dim.current > dim.ref ? '偏高' : '偏低'
  const devStr = Number.isFinite(dev) ? `${Math.round(dev * 100)}%` : '新增'
  const remedy = styleRemedy(dim.name, dim.current, dim.ref, body, dim.advice)
  return `${dim.name} ${dim.fmt(dim.current)} 偏离基线 ${dim.fmt(dim.ref)}（${direction} ${devStr}），${remedy}`
}

/** 检查单个数值维，偏离超阈值则推一条违规 */
function checkDim(dim: NumericDim, violations: RuleViolation[], body: string): void {
  if (deviationPct(dim.current, dim.ref) > DEVIATION_THRESHOLD) {
    violations.push({
      ruleId: 'style-consistency',
      level: 'yellow',
      message: dimMessage(dim, body),
    })
  }
}

/**
 * 风格一致规则（黄级：提示不卡流程）。
 * 无基线静默跳过；有基线时注入约束 + 逐维对比报黄。
 */
export const styleConsistencyRule: WritingRule = {
  id: 'style-consistency',
  level: 'yellow',
  tasks: ['self-heal', 'spawn-write', 'rewrite'],

  toPrompt(ctx): string | null {
    // 无基线静默跳过（不注入约束）
    if (!readBaseline(ctx.bookRoot)) return null
    return '保持文风一致——句长节奏/对话标签占比/复读率/形容词堆叠/排比连续度/单句超限占比应贴近已冻结的风格基线，任一维偏离基线 40% 以上会报黄'
  },

  check(body, ctx): RuleViolation[] {
    // 无基线静默跳过（不报违规）
    const baseline = readBaseline(ctx.bookRoot)
    if (!baseline) return []

    const rules = readIronRules(ctx.bookRoot)
    const stats = computeFullStats(body, rules)
    const ref = baseline.overall
    const violations: RuleViolation[] = []

    // 5 个无保护数值维（对话标签占比单独处理）
    const dims: NumericDim[] = [
      { name: '单句超限占比', current: stats.overlongRatio, ref: ref.overlongRatio, fmt: pct, advice: '建议拆分长句、控制单句长度' },
      { name: '形容词堆叠', current: stats.adjStackHits, ref: ref.adjStackHits, fmt: String, advice: '建议删减连续形容词' },
      { name: '排比连续度', current: stats.parallelStreakMax, ref: ref.parallelStreakMax, fmt: String, advice: '建议打散排比句式' },
      { name: '句长方差', current: stats.sentenceLenVariance, ref: ref.sentenceLenVariance, fmt: (v) => v.toFixed(1), advice: '建议调整句式节奏' },
      { name: '复读率', current: stats.repeatRate, ref: ref.repeatRate, fmt: pct, advice: '建议替换重复句式' },
    ]
    for (const dim of dims) checkDim(dim, violations, body)

    // 对话标签占比保护：无对话行时跳过（无对话不该报风格偏离）
    if (stats._dialogueLines > 0) {
      checkDim(
        { name: '对话标签占比', current: stats.dialogueTagRatio, ref: ref.dialogueTagRatio, fmt: pct, advice: '建议调整对话标签写法' },
        violations,
        body,
      )
    }

    // 结尾总结体（布尔维）：基线 false 但正文 true 报偏离（布尔不等，不做百分比）
    if (!ref.summaryEnding && stats.summaryEnding) {
      violations.push({
        ruleId: 'style-consistency',
        level: 'yellow',
        message: `结尾总结体 正文命中但基线未命中，${styleRemedy('结尾总结体', 1, 0, body)}`,
      })
    }

    return violations
  },
}
