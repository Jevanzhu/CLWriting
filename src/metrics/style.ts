/**
 * 文风重扫聚合 —— 体检报告「文风」维度（文风方案 §4–§5）。
 *
 * 与块 A（成本/审查落账）范式不同：文风机检是纯函数，定稿正文还在 → 按需重扫，无需落账。
 * 流程：读 文风/文风铁律.md 阈值 → 逐章 computeStyleMetrics + 句长方差/复读率 → 聚合 StyleTrend
 *   → 漂移判定（连续 N 章超限 / 前后段对比，只报趋势不下判决）→ 读 文风/基线.json 做对照。
 *
 * 口径对齐 checkStyleMetrics（订正记录第 3 条）：句长方差/复读率与 count.ts 同口径复算。
 * 纯 node:sqlite + 文件读，零模型（health 不耗模型契约）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readChapterDir } from '../format/chapters.js'
import { readSamplesByScene } from '../format/style.js'
import { readFile, parseFlat } from '../format/frontmatter.js'
import { parseIronRules, computeStyleMetrics, type IronRules, type StyleStats } from '../check/count.js'
import type { ChapterMeta } from '../format/types.js'

/** 含句长方差/复读率的完整文风指纹（StyleStats + 两个聚合用维度） */
export interface FullStyleStats extends StyleStats {
  sentenceLenVariance: number
  repeatRate: number
}

/** 基线指纹（文风方案 §5.2，byScene + overall） */
export interface StyleBaseline {
  version: number
  frozenAt: string
  frozenFrom: string
  byScene: Record<string, FullStyleStats>
  overall: FullStyleStats
}

/** 单章/篇文风采样 */
export interface ChapterSample {
  num: number
  title: string
  stats: FullStyleStats
}

/** 跨章聚合 + 漂移判定结果 */
export interface StyleTrend {
  kind: 'long' | 'short'
  count: number
  samples: ChapterSample[]
  /** 对话标签占比逐章序列 */
  dialogueTagSeries: number[]
  /** 句长方差逐章序列 */
  varianceSeries: number[]
  /** 复读率逐章序列 */
  repeatSeries: number[]
  /** 单句超限章号列表（overlongRatio>0 的章） */
  overlongChapters: number[]
  /** 形容词堆叠命中章号列表（adjStackHits>0 的章） */
  adjStackChapters: number[]
  /** 结尾总结体命中章号列表 */
  summaryEndingChapters: number[]
  /** 漂移信号（只报趋势不下判决） */
  drifts: StyleDrift[]
  baseline: StyleBaseline | null
}

export interface StyleDrift {
  metric: string
  message: string
}

/** 默认漂移窗口（连续 N 章超限报漂移，文风方案 §4.3 / OQ-V1，默认 N=5） */
const DEFAULT_DRIFT_WINDOW = 5

/** 短篇趋势判定阈值（< 此值只报明细，文风方案 §4.5 / OQ-V2） */
const SHORT_TREND_MIN = 5

/** 文风铁律路径 */
export function ironRulesPath(bookRoot: string): string {
  return join(bookRoot, '文风', '文风铁律.md')
}

/** 文风基线路径（进 git，作者可手改） */
export function baselinePath(bookRoot: string): string {
  return join(bookRoot, '文风', '基线.json')
}

/** 读铁律阈值；铁律文件不存在 → 空规则（各项不检，诚实降级） */
export function readIronRules(bookRoot: string): IronRules {
  const p = ironRulesPath(bookRoot)
  if (!existsSync(p)) return {}
  return parseIronRules(readFileSync(p, 'utf-8'))
}

/**
 * 读一章正文的 body（readChapterDir 返回 ChapterMeta 不含 body，订正第 4 条）。
 * 复用 frontmatter.readFile 剥 front matter。文件缺失/坏 → 返回 null。
 */
export function readChapterBody(chapter: ChapterMeta): string | null {
  if (!chapter._path) return null
  const r = readFile(chapter._path)
  if (!r.ok) return null
  return r.body
}

/** 句长方差（与 count.ts checkSentenceLength 同口径：按 。！？\n 切句算方差） */
export function computeSentenceLenVariance(body: string): number {
  const sentences = body.split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s.length > 0)
  if (sentences.length === 0) return 0
  const lens = sentences.map((s) => s.length)
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length
  const variance = lens.reduce((sum, len) => sum + (len - mean) ** 2, 0) / lens.length
  return variance
}

/** 复读率（与 count.ts checkRepeat 同口径：滑窗句级 n-gram 重复率） */
export function computeRepeatRate(body: string): number {
  const sentences = body.split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s.length >= 6)
  if (sentences.length === 0) return 0
  const counts = new Map<string, number>()
  for (const s of sentences) counts.set(s, (counts.get(s) ?? 0) + 1)
  let repeatInstances = 0
  for (const c of counts.values()) {
    if (c >= 2) repeatInstances += c - 1
  }
  return repeatInstances / sentences.length
}

/** 对一段正文算完整文风指纹（StyleStats 5 维 + 句长方差 + 复读率） */
export function computeFullStats(body: string, rules: IronRules): FullStyleStats {
  return {
    ...computeStyleMetrics(body, rules),
    sentenceLenVariance: computeSentenceLenVariance(body),
    repeatRate: computeRepeatRate(body),
  }
}

/** 长篇重扫：扫 定稿/正文/ 逐章算指纹 */
export function scanLongChapters(bookRoot: string): ChapterSample[] {
  const textDir = join(bookRoot, '定稿', '正文')
  const rules = readIronRules(bookRoot)
  const { chapters } = readChapterDir(textDir)
  const samples: ChapterSample[] = []
  for (const ch of chapters) {
    const body = readChapterBody(ch)
    if (body === null) continue
    samples.push({ num: ch.章号, title: ch.标题, stats: computeFullStats(body, rules) })
  }
  return samples.sort((a, b) => a.num - b.num)
}

/** 短篇重扫：扫 篇 下各目录的正文.md 逐篇算指纹（按篇号排序） */
export function scanShortPieces(bookRoot: string): ChapterSample[] {
  const piecesDir = join(bookRoot, '篇')
  const rules = readIronRules(bookRoot)
  const samples: ChapterSample[] = []
  if (!existsSync(piecesDir)) return samples
  let entries: string[]
  try {
    entries = readdirSync(piecesDir)
  } catch {
    return samples
  }
  for (const name of entries) {
    if (name.startsWith('._')) continue
    const dir = join(piecesDir, name)
    if (!statSync(dir).isDirectory()) continue
    const bodyPath = join(dir, '正文.md')
    if (!existsSync(bodyPath)) continue
    const r = readFile(bodyPath)
    if (!r.ok) continue
    // 篇号从文件名前缀取（NNN-标题）
    const numMatch = name.match(/^(\d+)/)
    const num = numMatch ? Number(numMatch[1]) : 0
    // 标题从 front matter 取，缺则用目录名
    const fm = parseFlat(r.fmRaw)
    const title = String(fm.get('标题') ?? name)
    samples.push({ num, title, stats: computeFullStats(r.body, rules) })
  }
  return samples.sort((a, b) => a.num - b.num)
}

/**
 * 跨章聚合 + 漂移判定。
 * 漂移判定原则（只报趋势不下判决）：单点偶发不报，连续/趋势才报。
 * 短篇 < SHORT_TREND_MIN 篇 → 不做趋势判定（诚实降级，文风方案 §4.5）。
 */
export function aggregateStyleTrend(
  samples: ChapterSample[],
  kind: 'long' | 'short',
  baseline: StyleBaseline | null,
  opts: { driftWindow?: number } = {},
): StyleTrend {
  const window = opts.driftWindow ?? DEFAULT_DRIFT_WINDOW
  const count = samples.length

  const dialogueTagSeries = samples.map((s) => s.stats.dialogueTagRatio)
  const varianceSeries = samples.map((s) => s.stats.sentenceLenVariance)
  const repeatSeries = samples.map((s) => s.stats.repeatRate)
  const overlongChapters = samples.filter((s) => s.stats.overlongRatio > 0).map((s) => s.num)
  const adjStackChapters = samples.filter((s) => s.stats.adjStackHits > 0).map((s) => s.num)
  const summaryEndingChapters = samples.filter((s) => s.stats.summaryEnding).map((s) => s.num)

  const drifts: StyleDrift[] = []
  // 短篇小样本不做趋势判定
  if (count >= SHORT_TREND_MIN) {
    // 对话标签占比：连续 N 章超 0.5（或基线对照值）报漂移
    const tagThreshold = baseline?.overall.dialogueTagRatio
      ? Math.max(baseline.overall.dialogueTagRatio * 1.3, 0.5)
      : 0.5
    drifts.push(...detectConsecutiveOver(
      dialogueTagSeries, samples.map((s) => s.num), tagThreshold, window,
      `对话标签占比连续 ${window}+ 章超 ${Math.round(tagThreshold * 100)}%`,
    ))
    // 结尾总结体：后 1/3 突增报漂移（疑似 AI 接管）
    const third = Math.floor(count / 3)
    if (third > 0) {
      const frontSummary = samples.slice(0, third).filter((s) => s.stats.summaryEnding).length
      const backSummary = samples.slice(-third).filter((s) => s.stats.summaryEnding).length
      if (backSummary > frontSummary && backSummary >= 2) {
        drifts.push({ metric: 'summaryEnding', message: `结尾总结体后段突增（前 ${third} 章 ${frontSummary} 处 → 后 ${third} 章 ${backSummary} 处），疑似漂移` })
      }
    }
    // 句长方差逐章攀升
    if (count >= window * 2) {
      const frontVar = avg(samples.slice(0, third).map((s) => s.stats.sentenceLenVariance))
      const backVar = avg(samples.slice(-third).map((s) => s.stats.sentenceLenVariance))
      if (backVar > frontVar * 1.5 && backVar - frontVar > 5) {
        drifts.push({ metric: 'variance', message: `句长方差后段攀升（前段 ${frontVar.toFixed(1)} → 后段 ${backVar.toFixed(1)}），节奏可能变僵` })
      }
    }
  }

  return {
    kind,
    count,
    samples,
    dialogueTagSeries,
    varianceSeries,
    repeatSeries,
    overlongChapters,
    adjStackChapters,
    summaryEndingChapters,
    drifts,
    baseline,
  }
}

/** 检测连续 N 个超阈值的点，返回漂移信号 */
function detectConsecutiveOver(
  series: number[],
  nums: number[],
  threshold: number,
  window: number,
  msg: string,
): StyleDrift[] {
  let streak = 0
  let streakStart = -1
  for (let i = 0; i < series.length; i++) {
    if (series[i]! > threshold) {
      if (streak === 0) streakStart = nums[i]!
      streak++
      if (streak >= window) {
        return [{ metric: 'dialogueTag', message: `${msg}（起于第 ${streakStart} 章）` }]
      }
    } else {
      streak = 0
    }
  }
  return []
}

// ── 基线冻结（#9）──────────────────────────────────

/** 读基线；文件不存在 → null（重扫降级为仅绝对值） */
export function readBaseline(bookRoot: string): StyleBaseline | null {
  const p = baselinePath(bookRoot)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown
    return coerceBaseline(raw)
  } catch {
    return null
  }
}

/** 冻结基线：扫 文风/样章库/ 逐场景算指纹 → 写 文风/基线.json（幂等覆盖）。
 *  空样章库 → 抛错不写文件（诚实，不伪装）。返回冻结的基线。 */
export function freezeBaseline(bookRoot: string): StyleBaseline {
  const sampleDir = join(bookRoot, '文风', '样章库')
  const rules = readIronRules(bookRoot)
  // 列出所有场景子目录
  let sceneEntries: string[]
  try {
    sceneEntries = readdirSync(sampleDir).filter((n) => !n.startsWith('._'))
  } catch {
    throw new Error('样章库目录不存在（文风/样章库/），无法冻结基线')
  }

  const byScene: Record<string, FullStyleStats> = {}
  const allBodies: { scene: string; body: string }[] = []
  for (const scene of sceneEntries) {
    const scenePath = join(sampleDir, scene)
    if (!statSync(scenePath).isDirectory()) continue
    const { samples } = readSamplesByScene(sampleDir, scene)
    if (samples.length === 0) continue // 空场景目录跳过
    const combined = samples.map((s) => s.正文).join('\n\n')
    byScene[scene] = computeFullStats(combined, rules)
    for (const s of samples) allBodies.push({ scene, body: s.正文 })
  }

  if (Object.keys(byScene).length === 0) {
    throw new Error('样章库为空（无有效样章），无法冻结基线')
  }

  const overallBody = allBodies.map((b) => b.body).join('\n\n')
  const baseline: StyleBaseline = {
    version: 1,
    frozenAt: new Date().toISOString(),
    frozenFrom: '文风/样章库',
    byScene,
    overall: computeFullStats(overallBody, rules),
  }

  const p = baselinePath(bookRoot)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(baseline, null, 2), 'utf-8')
  return baseline
}

// ── 格式化 ────────────────────────────────────────

/** 重扫报告 → 人话表格（文风方案 §4.4 输出形态） */
export function formatStyleReport(trend: StyleTrend): string {
  if (trend.count === 0) {
    return '尚无已定稿正文可重扫。写完并定稿一章/篇后再看（health --style）。\n'
  }
  const unit = trend.kind === 'short' ? '篇' : '章'
  const lines: string[] = []
  const baselineStr = trend.baseline
    ? `基线来自 ${trend.baseline.frozenFrom}`
    : '无基线（仅显示绝对值，可 health --style --freeze 冻结）'
  lines.push(`文风对齐体检 · 基于 ${trend.count} ${unit} · ${baselineStr}`)
  lines.push('─'.repeat(52))

  const hasBaseline = trend.baseline !== null
  // 对话标签占比
  const avgTag = avg(trend.dialogueTagSeries)
  const baseTag = trend.baseline?.overall.dialogueTagRatio
  lines.push(formatLine('对话标签占比', `${(avgTag * 100).toFixed(0)}%`,
    hasBaseline && baseTag !== undefined ? `基线 ${(baseTag * 100).toFixed(0)}%` : '',
    avgTag > 0.5 ? '⚠' : '✓'))
  // 单句超限
  const overlongPct = trend.count > 0 ? (trend.overlongChapters.length / trend.count) * 100 : 0
  lines.push(formatLine('单句超限', `${trend.overlongChapters.length}/${trend.count} ${unit}（${overlongPct.toFixed(0)}%）`, '', overlongPct > 30 ? '⚠' : '✓'))
  // 形容词堆叠
  const adjPct = trend.count > 0 ? (trend.adjStackChapters.length / trend.count) * 100 : 0
  lines.push(formatLine('形容词堆叠', `${trend.adjStackChapters.length}/${trend.count} ${unit}（${adjPct.toFixed(0)}%）`, '', adjPct > 30 ? '⚠' : '✓'))
  // 句长方差
  const avgVar = avg(trend.varianceSeries)
  const baseVar = trend.baseline?.overall.sentenceLenVariance
  lines.push(formatLine('句长方差', avgVar.toFixed(1),
    hasBaseline && baseVar !== undefined ? `基线 ${baseVar.toFixed(1)}` : '',
    hasBaseline && baseVar !== undefined && avgVar > baseVar * 1.3 ? '○ 略高' : '✓'))
  // 复读率
  const avgRepeat = avg(trend.repeatSeries)
  lines.push(formatLine('复读率', `${(avgRepeat * 100).toFixed(1)}%`, '', avgRepeat > 0.1 ? '⚠' : '✓'))
  // 结尾总结体
  const summaryPct = trend.count > 0 ? (trend.summaryEndingChapters.length / trend.count) * 100 : 0
  lines.push(formatLine('结尾总结体', `${trend.summaryEndingChapters.length}/${trend.count} ${unit}（${summaryPct.toFixed(0)}%）`, '', trend.summaryEndingChapters.length > 0 ? '⚠' : '✓'))

  // 漂移信号
  if (trend.drifts.length > 0) {
    lines.push('')
    lines.push('⚠ 漂移信号（建议复核，非判决）：')
    for (const d of trend.drifts) {
      lines.push(`  · ${d.message}`)
    }
  }

  // 短篇小样本提示
  if (trend.kind === 'short' && trend.count < SHORT_TREND_MIN) {
    lines.push('')
    lines.push(`（短篇 ${trend.count} 篇 < ${SHORT_TREND_MIN}，仅报明细不做趋势判定）`)
  }

  lines.push('')
  return lines.join('\n')
}

function formatLine(metric: string, value: string, extra: string, mark: string): string {
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)))
  return `  ${pad(metric, 12)} ${pad(value, 18)} ${pad(extra, 16)} ${mark}`
}

/** 近似显示宽度（中文算 2） */
function width(s: string): number {
  let w = 0
  for (const ch of s) {
    w += /[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch) ? 2 : 1
  }
  return w
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

/** 松散对象 → StyleBaseline 校验 */
function coerceBaseline(raw: unknown): StyleBaseline | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const bySceneRaw = o['byScene']
  const overallRaw = o['overall']
  if (!bySceneRaw || typeof bySceneRaw !== 'object' || !overallRaw || typeof overallRaw !== 'object') return null
  const byScene: Record<string, FullStyleStats> = {}
  for (const [scene, stats] of Object.entries(bySceneRaw as Record<string, unknown>)) {
    const s = coerceStats(stats)
    if (s) byScene[scene] = s
  }
  const overall = coerceStats(overallRaw)
  if (!overall) return null
  return {
    version: Number(o['version']) || 1,
    frozenAt: String(o['frozenAt'] ?? ''),
    frozenFrom: String(o['frozenFrom'] ?? ''),
    byScene,
    overall,
  }
}

function coerceStats(raw: unknown): FullStyleStats | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const overlongRatio = Number(o['overlongRatio'])
  const dialogueTagRatio = Number(o['dialogueTagRatio'])
  const sentenceLenVariance = Number(o['sentenceLenVariance'])
  const repeatRate = Number(o['repeatRate'])
  if (![overlongRatio, dialogueTagRatio, sentenceLenVariance, repeatRate].every(Number.isFinite)) return null
  return {
    overlongRatio,
    adjStackHits: Number(o['adjStackHits']) || 0,
    dialogueTagRatio,
    parallelStreakMax: Number(o['parallelStreakMax']) || 0,
    summaryEnding: o['summaryEnding'] === true,
    sentenceLenVariance,
    repeatRate,
    _dialogueLines: Number(o['_dialogueLines']) || 0,
  }
}
