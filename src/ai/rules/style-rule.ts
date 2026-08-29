/**
 * 风格一致规则（A3 软约束三项之三）。
 *
 * 实时读已冻结的风格基线（文风/基线.json），对比当前正文的 7 维文风指纹。
 * 注入侧：告知 AI 贴近基线；检验侧：任一维偏离超 40% 报黄（提示不卡流程）。
 *
 * 设计要点：
 * - 静态规则对象（方案 A），check 内部实时读基线（不缓存——基线可能写稿中途冻结）
 * - 无基线静默跳过（toPrompt 返回 null、check 返回空数组），不报错不卡流程
 * - 比率维（单句超限占比/复读率/句长方差/对话标签占比）尺度天然与长度无关，
 *   双侧百分比偏离比较；计数维与极值维的口径见 R75-1（正文两段分述）
 * - summaryEnding 为布尔维度：基线 false 但正文 true 报偏离
 * - 对话标签占比保护：无对话行（_dialogueLines===0）时跳过 dialogueTagRatio 维
 */
import { ruleStripFm, type WritingRule, type RuleViolation } from './types.js'
import { readBaseline, readIronRules, computeFullStats } from '../../metrics/style.js'
import { styleRemedy } from './style-remedy.js'

/** 偏离阈值：偏离超此比例报黄（40%） */
const DEVIATION_THRESHOLD = 0.4

/** R75-1（批 A）：计数维密度归一基准——次/千字 */
const PER_K_CHARS = 1000

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

/** R75-1：千字密度格式化（如 1.50 次/千字） */
function fmtPerKChars(v: number): string {
  return `${v.toFixed(2)} 次/千字`
}

/** R75-1：计数维 → 千字密度（hits / charCount × 1000）。
 *  charCount 缺失（旧 v1 冻结基线无该字段）或非正（空正文）→ null：无法归一，
 *  调用方降级跳过该维（宁缺毋假——比原始计数正是量纲错配假阳的来源）。 */
function densityPerKChars(hits: number, charCount: number | undefined): number | null {
  if (charCount === undefined || charCount <= 0) return null
  return (hits / charCount) * PER_K_CHARS
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
    // 统计前剥 fm：fm 短行会污染句长/占比指纹（body 含 fm 是规则引擎契约，正文型规则各自剥）
    const stats = computeFullStats(ruleStripFm(body), rules)
    const ref = baseline.overall
    const violations: RuleViolation[] = []

    // 3 个比率维（对话标签占比单独处理）：尺度与文本长度天然无关，双侧比较
    const dims: NumericDim[] = [
      { name: '单句超限占比', current: stats.overlongRatio, ref: ref.overlongRatio, fmt: pct, advice: '建议拆分长句、控制单句长度' },
      { name: '句长方差', current: stats.sentenceLenVariance, ref: ref.sentenceLenVariance, fmt: (v) => v.toFixed(1), advice: '建议调整句式节奏' },
      { name: '复读率', current: stats.repeatRate, ref: ref.repeatRate, fmt: pct, advice: '建议替换重复句式' },
    ]
    for (const dim of dims) checkDim(dim, violations, body)

    // R75-1（批 A，量纲错配修复）：ref.overall 是全部样章 join('\n\n') 的拼接语料指纹，
    // 而本规则对比的是单章正文——计数维直接比原始值在样章库 ≥2 条时天然「偏低」
    // 常态超 40% 阈值，机检稳定产出假黄项并流入重写反馈。两维按下述口径分别修：
    //
    // 形容词堆叠（真计数维，随长度近似线性增长）→ 双侧密度比较（次/千字）：正文与
    // 基线各除以自身 charCount（R75-1 在 FullStyleStats 增量加的归一化因子）再比，
    // 长度量纲抵消。旧 v1 冻结基线缺 charCount 无法归一 → 降级跳过本维（不比原始
    // 计数——那正是假阳来源；重新冻结基线即恢复密度比较）。去重口径注：拼接语料跨
    // 样章去重使 overall 密度略低于单样章均值，方向保守（略偏「单章偏高」），在
    // 40% 阈值带宽内可忽略。
    const adjCur = densityPerKChars(stats.adjStackHits, stats.charCount)
    const adjRef = densityPerKChars(ref.adjStackHits, ref.charCount)
    if (adjCur !== null && adjRef !== null) {
      checkDim(
        { name: '形容词堆叠', current: adjCur, ref: adjRef, fmt: fmtPerKChars, advice: '建议删减连续形容词' },
        violations,
        body,
      )
    }

    // 排比连续度（极值统计：拼接语料上的最大值）→ 密度归一不成立：E[max] 随句数
    // 增长远慢于线性（对数级），按长度归一后单章密度系统性偏高，会把旧假阳「偏低」
    // 换成新假阳「偏高」；且语料 max 是 k 个样章的极值，单章 max ≤ 语料 max 是常态，
    // 双侧比较的低侧是结构性噪声（正是原假阳来源）。只保「偏高」单侧：章 max 显著
    // 超语料 max（作者样章从未出现过的排比强度）才是真偏离信号；绝对上限另有文风
    // 铁律 maxParallelStreak 的红黄项兜底（checkStyleMetrics），低侧放弃不损覆盖。
    if (stats.parallelStreakMax > ref.parallelStreakMax) {
      checkDim(
        { name: '排比连续度', current: stats.parallelStreakMax, ref: ref.parallelStreakMax, fmt: String, advice: '建议打散排比句式' },
        violations,
        body,
      )
    }

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
