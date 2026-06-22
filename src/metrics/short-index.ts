/**
 * 短篇集级索引与重复风险体检。
 *
 * 目标：短篇主链已按单篇闭环，本模块只做整集层面的轻量扫描。
 * 数据来自已定稿 `篇/<篇号>-<标题>/正文.md` 与同目录 `清单.md`，
 * 不写文件、不耗模型，用于 health --report 的短篇集节奏提示。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readPiece } from '../format/pieces.js'
import { readPieceList } from '../format/manifest.js'
import { readFile } from '../format/frontmatter.js'
import { countWords } from '../format/chapters.js'
import type { BookConfig, PieceList } from '../format/types.js'
import type { MetricRecord } from './ledger.js'

export interface ShortPieceIndexEntry {
  num: number
  title: string
  targetEmotion: string
  coreReversal: string
  reversalType: string
  structureObjects: string[]
  endingFlavor: string
}

export interface ShortCollectionRisk {
  kind: 'recent-repeat' | 'collection-repeat'
  field: 'targetEmotion' | 'reversalType' | 'coreReversal' | 'structureObject' | 'endingFlavor'
  message: string
  pieces: number[]
}

export interface ShortCollectionReport {
  count: number
  entries: ShortPieceIndexEntry[]
  risks: ShortCollectionRisk[]
}

export interface ShortCalibrationSample {
  num: number
  title: string
  words: number
  sectionCount: number | null
  maxBodyPartCount: number
  simileCount: number
  openingEnvHits: string[]
}

export interface ShortCalibrationReport {
  count: number
  current: NonNullable<BookConfig['short']>
  recommended: NonNullable<BookConfig['short']>
  confidence: 'low' | 'medium' | 'high'
  samples: ShortCalibrationSample[]
  notes: string[]
}

export interface ShortBudgetCalibrationReport {
  count: number
  currentLimit: number
  avgCalls: number
  p80Calls: number
  p90Calls: number
  recommendedLimit: number
  overLimit: number
  nearLimit: number
  missingAccounting: number
}

const DEFAULT_SHORT_CONFIG: NonNullable<BookConfig['short']> = {
  word_min: 8000,
  word_max: 20000,
  body_part_threshold: 5,
  simile_threshold: 10,
  section_count: 5,
  opening_env_chars: 300,
}

const BODY_PART_WORDS = ['眼睛', '眼神', '眼眶', '手指', '手掌', '心脏', '心跳', '脸庞', '嘴角', '眉头', '喉咙', '呼吸']
const HAND_ACTION_RE = /(?:伸|握|抓|拉|抬|挥|摊|攥|搓|叉|捂|托|撑|扶|搭|拽|按|放|松|紧|握住|抓住)了?手/g
const ENV_WORDS = ['天气', '阳光', '月光', '日升', '日落', '天空', '云层', '乌云', '风声', '狂风', '雨声', '雨点', '景色', '远山', '树林', '街道', '建筑']

/** 扫描短篇集索引。 */
export function scanShortCollection(bookRoot: string): ShortPieceIndexEntry[] {
  const piecesDir = join(bookRoot, '篇')
  if (!existsSync(piecesDir)) return []
  let names: string[]
  try {
    names = readdirSync(piecesDir)
  } catch {
    return []
  }

  const entries: ShortPieceIndexEntry[] = []
  for (const name of names) {
    if (name.startsWith('._')) continue
    const dir = join(piecesDir, name)
    if (!safeIsDirectory(dir)) continue
    const bodyPath = join(dir, '正文.md')
    if (!existsSync(bodyPath)) continue

    const piece = readPiece(bodyPath)
    if (!piece.ok) continue
    const list = readListIfExists(join(dir, '清单.md'))
    const coreReversal = firstReal(piece.piece.核心反转, list?.反转线索表.核心反转)
    entries.push({
      num: piece.piece.篇号,
      title: piece.piece.标题,
      targetEmotion: cleanValue(piece.piece.目标情绪),
      coreReversal,
      reversalType: classifyReversal(coreReversal),
      structureObjects: collectStructureObjects(list),
      endingFlavor: endingFlavorOf(list),
    })
  }
  return entries.sort((a, b) => a.num - b.num)
}

export function analyzeShortCollection(entries: ShortPieceIndexEntry[]): ShortCollectionReport {
  return {
    count: entries.length,
    entries,
    risks: [
      ...recentRepeatRisks(entries, 'targetEmotion', '目标情绪'),
      ...recentRepeatRisks(entries, 'reversalType', '反转类型'),
      ...recentRepeatRisks(entries, 'endingFlavor', '结尾味道'),
      ...collectionRepeatRisk(entries, 'coreReversal', '核心反转'),
      ...objectRepeatRisks(entries),
    ],
  }
}

export function formatShortCollectionReport(report: ShortCollectionReport): string {
  if (report.count === 0) return ''
  const lines: string[] = []
  lines.push('短篇集节奏体检')
  lines.push('─'.repeat(48))
  lines.push(`  已定稿 ${report.count} 篇；索引维度：目标情绪 / 反转类型 / 结构物件 / 结尾味道`)
  if (report.risks.length === 0) {
    lines.push('  ✓ 暂未发现明显重复风险')
  } else {
    lines.push('  ⚠ 重复风险（建议复核，非判决）：')
    for (const risk of report.risks.slice(0, 8)) {
      lines.push(`  · ${risk.message}（篇 ${risk.pieces.join('、')}）`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

export function scanShortCalibrationSamples(bookRoot: string, openingChars = 300): ShortCalibrationSample[] {
  const piecesDir = join(bookRoot, '篇')
  if (!existsSync(piecesDir)) return []
  let names: string[]
  try {
    names = readdirSync(piecesDir)
  } catch {
    return []
  }

  const samples: ShortCalibrationSample[] = []
  for (const name of names) {
    if (name.startsWith('._')) continue
    const dir = join(piecesDir, name)
    if (!safeIsDirectory(dir)) continue
    const bodyPath = join(dir, '正文.md')
    if (!existsSync(bodyPath)) continue
    const piece = readPiece(bodyPath)
    const file = readFile(bodyPath)
    if (!piece.ok || !file.ok) continue
    samples.push({
      num: piece.piece.篇号,
      title: piece.piece.标题,
      words: countWords(file.body),
      sectionCount: countHeadingSections(file.body),
      maxBodyPartCount: countMaxBodyPart(file.body),
      simileCount: countLiteral(file.body, '像'),
      openingEnvHits: collectOpeningEnvHits(file.body, openingChars),
    })
  }
  return samples.sort((a, b) => a.num - b.num)
}

export function analyzeShortCalibration(
  samples: ShortCalibrationSample[],
  currentConfig: BookConfig['short'] | undefined,
): ShortCalibrationReport {
  const current = { ...DEFAULT_SHORT_CONFIG, ...currentConfig }
  const notes: string[] = []
  if (samples.length === 0) {
    return {
      count: 0,
      current,
      recommended: { ...current },
      confidence: 'low',
      samples,
      notes: ['暂无已定稿短篇样本，先沿用当前阈值。'],
    }
  }

  const words = samples.map((s) => s.words).sort((a, b) => a - b)
  const bodyParts = samples.map((s) => s.maxBodyPartCount).sort((a, b) => a - b)
  const similes = samples.map((s) => s.simileCount).sort((a, b) => a - b)
  const sectionCounts = samples.map((s) => s.sectionCount).filter((v): v is number => v !== null)
  const openingHitRate = samples.filter((s) => s.openingEnvHits.length > 0).length / samples.length

  const wordMin = clamp(roundDown(percentile(words, 0.2), 500), 3000, 12000)
  const wordMax = Math.max(wordMin + 2000, clamp(roundUp(percentile(words, 0.9), 500), 6000, 30000))
  const recommended: NonNullable<BookConfig['short']> = {
    word_min: wordMin,
    word_max: wordMax,
    body_part_threshold: clamp(Math.max(3, Math.ceil(percentile(bodyParts, 0.9)) + 1), 3, 12),
    simile_threshold: clamp(Math.max(5, Math.ceil(percentile(similes, 0.9)) + 1), 5, 20),
    section_count: mode(sectionCounts) ?? current.section_count,
    opening_env_chars: openingHitRate > 0.4
      ? clamp((current.opening_env_chars ?? 300) - 80, 160, 500)
      : current.opening_env_chars,
  }

  if (samples.length < 5) notes.push(`样本 ${samples.length} 篇，建议先当趋势参考，不直接覆盖配置。`)
  if (sectionCounts.length < samples.length) notes.push(`${samples.length - sectionCounts.length} 篇未使用 ## 五段标题，节数建议置信度偏低。`)
  if (openingHitRate > 0.4) notes.push(`开头环境词命中率 ${(openingHitRate * 100).toFixed(0)}%，建议缩短黄金开头检查窗口或重写开篇。`)
  if (notes.length === 0) notes.push('样本分布稳定，可把推荐值作为下一轮 book.yaml short 候选。')

  return {
    count: samples.length,
    current,
    recommended,
    confidence: samples.length >= 10 ? 'high' : samples.length >= 5 ? 'medium' : 'low',
    samples,
    notes,
  }
}

export function formatShortCalibrationReport(report: ShortCalibrationReport): string {
  if (report.count === 0) return ''
  const lines: string[] = []
  const avgWords = avg(report.samples.map((s) => s.words))
  const openingHits = report.samples.filter((s) => s.openingEnvHits.length > 0).length
  lines.push('短篇阈值回灌建议')
  lines.push('─'.repeat(48))
  lines.push(`  样本 ${report.count} 篇，置信度：${confidenceLabel(report.confidence)}，平均字数 ${avgWords.toFixed(0)}`)
  lines.push(`  建议 short: word_min ${report.recommended.word_min} / word_max ${report.recommended.word_max}`)
  lines.push(`  建议洁净阈值：身体部位词 ≤${report.recommended.body_part_threshold} / 「像」≤${report.recommended.simile_threshold} / 节数 ${report.recommended.section_count}`)
  lines.push(`  开头环境词：${openingHits}/${report.count} 篇命中，opening_env_chars 建议 ${report.recommended.opening_env_chars}`)
  for (const note of report.notes.slice(0, 3)) lines.push(`  · ${note}`)
  lines.push('')
  return lines.join('\n')
}

export function analyzeShortBudgetCalibration(
  records: MetricRecord[],
  currentLimit: number,
): ShortBudgetCalibrationReport {
  const shortRecords = records
    .filter((r) => r.kind === 'short')
    .sort((a, b) => a.num - b.num)
  const totals = shortRecords.map((r) => r.calls.total).sort((a, b) => a - b)
  const avgCalls = avg(totals)
  const p80Calls = percentile(totals, 0.8)
  const p90Calls = percentile(totals, 0.9)
  const recommendedLimit = totals.length === 0
    ? currentLimit
    : clamp(Math.max(3, Math.ceil(p90Calls) + 1), 3, 20)
  return {
    count: shortRecords.length,
    currentLimit,
    avgCalls,
    p80Calls,
    p90Calls,
    recommendedLimit,
    overLimit: shortRecords.filter((r) => r.calls.total > r.calls.limit).length,
    nearLimit: shortRecords.filter((r) => r.calls.limit > 0 && r.calls.total >= r.calls.limit * 0.8).length,
    missingAccounting: shortRecords.filter((r) => r.calls.total === 0 || r.calls.outline === 0 || r.calls.draft === 0 || (r.review !== null && r.calls.review === 0)).length,
  }
}

export function formatShortBudgetCalibrationReport(report: ShortBudgetCalibrationReport): string {
  if (report.count === 0) return ''
  const lines: string[] = []
  lines.push('短篇预算校准建议')
  lines.push('─'.repeat(48))
  lines.push(`  样本 ${report.count} 篇：平均 ${report.avgCalls.toFixed(1)} 次/篇，P80 ${report.p80Calls.toFixed(1)}，P90 ${report.p90Calls.toFixed(1)}`)
  lines.push(`  当前 calls_per_chapter ${report.currentLimit}；建议候选 ${report.recommendedLimit}`)
  if (report.overLimit > 0 || report.nearLimit > 0) {
    lines.push(`  · ${report.overLimit} 篇超限，${report.nearLimit} 篇接近上限；建议调高或降低 best-of-N/审查档位。`)
  } else {
    lines.push('  · 暂未触顶；候选值用于后续真实批量样本复核。')
  }
  if (report.missingAccounting > 0) {
    lines.push(`  · ${report.missingAccounting} 篇疑似记账不完整，先补 record-call/token 再拍默认值。`)
  }
  lines.push('')
  return lines.join('\n')
}

function readListIfExists(path: string): PieceList | null {
  if (!existsSync(path)) return null
  const r = readPieceList(path)
  return r.ok ? r.list : null
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function collectStructureObjects(list: PieceList | null): string[] {
  if (!list) return []
  const raw = [
    ...list.伏笔回收.map((p) => p.伏笔),
    ...list.反转线索表.铺垫点.map((p) => p.内容),
  ]
  const objects = raw.map(extractObject).filter((v) => v.length > 0)
  return [...new Set(objects)].slice(0, 6)
}

function endingFlavorOf(list: PieceList | null): string {
  const curve = list?.情绪曲线 ?? []
  const last = [...curve].reverse().find((p) => !isPlaceholder(p.情绪))
  return cleanValue(last?.情绪)
}

function recentRepeatRisks(
  entries: ShortPieceIndexEntry[],
  field: 'targetEmotion' | 'reversalType' | 'endingFlavor',
  label: string,
): ShortCollectionRisk[] {
  if (entries.length < 3) return []
  const recent = entries.slice(-3)
  const values = recent.map((entry) => entry[field]).filter((v) => v.length > 0 && v !== '未知')
  if (values.length !== 3) return []
  if (new Set(values).size !== 1) return []
  return [{
    kind: 'recent-repeat',
    field,
    message: `最近 3 篇${label}都为「${values[0]}」`,
    pieces: recent.map((entry) => entry.num),
  }]
}

function collectionRepeatRisk(
  entries: ShortPieceIndexEntry[],
  field: 'coreReversal',
  label: string,
): ShortCollectionRisk[] {
  const grouped = groupBy(entries, (entry) => normalize(entry[field]))
  const risks: ShortCollectionRisk[] = []
  for (const [key, group] of grouped) {
    if (!key || group.length < 2) continue
    risks.push({
      kind: 'collection-repeat',
      field,
      message: `${label}重复：「${group[0]![field]}」出现 ${group.length} 次`,
      pieces: group.map((entry) => entry.num),
    })
  }
  return risks
}

function objectRepeatRisks(entries: ShortPieceIndexEntry[]): ShortCollectionRisk[] {
  const pairs = entries.flatMap((entry) => entry.structureObjects.map((object) => ({ entry, object })))
  const grouped = groupBy(pairs, (pair) => normalize(pair.object))
  const risks: ShortCollectionRisk[] = []
  for (const [key, group] of grouped) {
    const nums = [...new Set(group.map((pair) => pair.entry.num))]
    if (!key || nums.length < 2) continue
    risks.push({
      kind: 'collection-repeat',
      field: 'structureObject',
      message: `结构物件/伏笔「${group[0]!.object}」重复出现`,
      pieces: nums,
    })
  }
  return risks
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    if (!key) continue
    const group = map.get(key) ?? []
    group.push(item)
    map.set(key, group)
  }
  return map
}

function classifyReversal(text: string): string {
  const t = normalize(text)
  if (!t) return '未知'
  if (/死者|尸体|亡者|鬼|幽灵/.test(t)) return '死者反转'
  if (/凶手|真凶|杀手|犯人/.test(t)) return '真凶反转'
  if (/自己|本人|主角|我/.test(t)) return '自我反转'
  if (/亲人|父亲|母亲|哥哥|姐姐|弟弟|妹妹|妻子|丈夫|恋人/.test(t)) return '亲密关系反转'
  if (/身份|卧底|替身|冒名|伪装|假扮/.test(t)) return '身份反转'
  if (/时间|循环|未来|过去|记忆/.test(t)) return '时间/记忆反转'
  if (/梦|幻觉|剧本|游戏|实验/.test(t)) return '现实层反转'
  return '其他反转'
}

function extractObject(text: string): string {
  const cleaned = cleanValue(text)
    .replace(/^(开头|中段|尾声|结尾|反转|铺垫|升级)/, '')
    .replace(/[，。！？、；：:]/g, ' ')
    .trim()
  const quoted = cleaned.match(/「([^」]{1,12})」/)
  if (quoted) return quoted[1]!.trim()
  const compact = cleaned.replace(/\s+/g, '')
  if (compact.length <= 12) return compact
  return compact.slice(0, 12)
}

function firstReal(...values: (string | undefined)[]): string {
  for (const value of values) {
    const cleaned = cleanValue(value)
    if (!isPlaceholder(cleaned)) return cleaned
  }
  return ''
}

function cleanValue(value: string | undefined): string {
  return (value ?? '').trim()
}

function normalize(value: string): string {
  return value.replace(/\s+/g, '').replace(/[，。！？、；：:「」"'（）()]/g, '').trim()
}

function isPlaceholder(value: string | undefined): boolean {
  const v = cleanValue(value)
  return v === '' || v === '待定' || v === '待补' || v === '（待补）'
}

function countHeadingSections(body: string): number | null {
  const count = body.split(/^##\s/m).filter((s) => s.trim().length > 0).length
  return count >= 2 ? count : null
}

function countMaxBodyPart(body: string): number {
  const counts = BODY_PART_WORDS.map((word) => countLiteral(body, word))
  counts.push((body.match(HAND_ACTION_RE) ?? []).length)
  return Math.max(0, ...counts)
}

function countLiteral(body: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = body.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = body.indexOf(needle, idx + needle.length)
  }
  return count
}

function collectOpeningEnvHits(body: string, openingChars: number): string[] {
  const opening = body.slice(0, openingChars)
  return ENV_WORDS.filter((word) => opening.includes(word))
}

function percentile(sortedNums: number[], p: number): number {
  if (sortedNums.length === 0) return 0
  const idx = (sortedNums.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedNums[lo]!
  const weight = idx - lo
  return sortedNums[lo]! * (1 - weight) + sortedNums[hi]! * weight
}

function roundDown(value: number, step: number): number {
  return Math.floor(value / step) * step
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((sum, n) => sum + n, 0) / nums.length
}

function mode(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined
  const counts = new Map<number, number>()
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]
}

function confidenceLabel(confidence: ShortCalibrationReport['confidence']): string {
  if (confidence === 'high') return '高'
  if (confidence === 'medium') return '中'
  return '低'
}
