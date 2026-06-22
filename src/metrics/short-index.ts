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
import type { BookConfig, PieceList, SetupPoint } from '../format/types.js'
import type { MetricRecord } from './ledger.js'

export interface ShortPieceIndexEntry {
  num: number
  title: string
  wordCount: number
  targetEmotion: string
  coreReversal: string
  reversalType: string
  structureObjects: string[]
  endingFlavor: string
  reversalQuality: ShortReversalQuality
}

export interface ShortReversalQuality {
  score: number
  grade: '弱' | '中' | '强'
  setupCount: number
  anchoredSetupCount: number
  payoffClosed: number
  payoffOpen: number
  payoffMatched: number
  peakStrength: number | null
  issues: string[]
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
  platform: ShortPlatformProfileReport
  platformTargets: ShortPlatformTargets
  planning: ShortPlanningView
  risks: ShortCollectionRisk[]
}

export interface ShortPlatformProfileReport {
  profile: string
  wordMin: number
  wordMax: number
  hookWindow: number
  emphasis: string
  avgWords: number
  weakReversals: number
  targetGaps: string[]
  notes: string[]
}

export interface ShortPlatformTargets {
  targetEmotions: string[]
  targetReversalTypes: string[]
  targetEndingFlavors: string[]
}

export interface ShortPlanningView {
  emotions: DistributionItem[]
  reversalTypes: DistributionItem[]
  endingFlavors: DistributionItem[]
  structureObjects: DistributionItem[]
}

export interface DistributionItem {
  value: string
  count: number
  pieces: number[]
}

export interface ShortDraftGuidance {
  nextPiece: number
  profile: string
  emphasis: string
  avoid: string[]
  fill: string[]
  checklist: string[]
}

export interface ShortSubmissionItem {
  num: number
  title: string
  words: number
  targetEmotion: string
  reversalType: string
  endingFlavor: string
  pitch: string
}

export type ShortSubmissionPlatform = 'generic' | 'wechat' | 'zhihu-salt' | 'fanqie' | 'xiaohongshu'

export interface ShortSubmissionTemplate {
  platform: ShortSubmissionPlatform
  label: string
  titleStyle: string
  introLength: string
  sellingPoints: string[]
}

export interface ShortQualityTrendReport {
  count: number
  window: number
  recentAvgScore: number
  previousAvgScore: number | null
  direction: '上升' | '下降' | '持平' | '样本不足'
  recentWordMin: number
  recentWordMax: number
  recentEndingFlavor: DistributionItem | null
  signals: string[]
  notes: string[]
}

export interface ShortSeriesMotifReport {
  count: number
  declaredMotifs: string[]
  observedMotifs: DistributionItem[]
  underusedMotifs: string[]
  repeatedMotifs: DistributionItem[]
  notes: string[]
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
  usableCount: number
  currentLimit: number
  avgCalls: number
  p80Calls: number
  p90Calls: number
  recommendedLimit: number
  overLimit: number
  nearLimit: number
  missingAccounting: number
}

export interface ShortRepairPlanIssue {
  reason: string
  action: string
}

export interface ShortRepairPlanItem {
  num: number
  title: string
  priority: '高' | '中' | '低'
  score: number
  reasons: string[]
  actions: string[]
}

export interface ShortRepairPlanReport {
  count: number
  items: ShortRepairPlanItem[]
  collectionActions: string[]
  notes: string[]
}

const DEFAULT_SHORT_CONFIG: NonNullable<BookConfig['short']> = {
  profile: '通用短篇',
  target_emotions: ['惊悚', '爽感', '酸涩', '温暖'],
  target_reversal_types: ['身份反转', '亲密关系反转', '时间/记忆反转', '其他反转'],
  target_ending_flavors: ['后怕', '释然', '遗憾', '余韵'],
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

const SUBMISSION_TEMPLATES: Record<ShortSubmissionPlatform, ShortSubmissionTemplate> = {
  generic: {
    platform: 'generic',
    label: '通用',
    titleStyle: '保留作品原题，突出题材与核心反转',
    introLength: '80-150 字',
    sellingPoints: ['目标情绪', '核心反转', '结尾味道'],
  },
  wechat: {
    platform: 'wechat',
    label: '公众号',
    titleStyle: '情绪钩 + 人物困境，少用平台黑话',
    introLength: '100-180 字',
    sellingPoints: ['开头钩子', '人物共情点', '转发讨论点'],
  },
  'zhihu-salt': {
    platform: 'zhihu-salt',
    label: '知乎盐选',
    titleStyle: '第一人称困境或强问题句，悬念前置',
    introLength: '120-200 字',
    sellingPoints: ['强悬念', '信息差', '付费后反转'],
  },
  fanqie: {
    platform: 'fanqie',
    label: '番茄短故事',
    titleStyle: '题材词 + 冲突关系 + 明确爽点',
    introLength: '80-140 字',
    sellingPoints: ['快节奏', '冲突升级', '即时清算'],
  },
  xiaohongshu: {
    platform: 'xiaohongshu',
    label: '小红书故事号',
    titleStyle: '口语化爆点标题，适合截图传播',
    introLength: '40-90 字',
    sellingPoints: ['一句话钩子', '情绪标签', '评论区讨论点'],
  },
}

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
    const file = readFile(bodyPath)
    const list = readListIfExists(join(dir, '清单.md'))
    const coreReversal = firstReal(piece.piece.核心反转, list?.反转线索表.核心反转)
    const body = file.ok ? file.body : ''
    entries.push({
      num: piece.piece.篇号,
      title: piece.piece.标题,
      wordCount: file.ok ? countWords(body) : 0,
      targetEmotion: cleanValue(piece.piece.目标情绪),
      coreReversal,
      reversalType: classifyReversal(coreReversal),
      structureObjects: collectStructureObjects(list),
      endingFlavor: endingFlavorOf(list),
      reversalQuality: scoreReversalQuality(coreReversal, list, body),
    })
  }
  return entries.sort((a, b) => a.num - b.num)
}

export function analyzeShortCollection(
  entries: ShortPieceIndexEntry[],
  shortConfig: BookConfig['short'] | undefined = undefined,
): ShortCollectionReport {
  const config = { ...DEFAULT_SHORT_CONFIG, ...shortConfig }
  return {
    count: entries.length,
    entries,
    platform: analyzePlatformProfile(entries, config),
    platformTargets: platformTargetsOf(config),
    planning: analyzePlanningView(entries),
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
  lines.push(`  短篇平台画像：${report.platform.profile}（建议 ${report.platform.wordMin}–${report.platform.wordMax} 字，开头窗口 ${report.platform.hookWindow} 字）`)
  lines.push(`  画像重点：${report.platform.emphasis}`)
  for (const note of report.platform.notes.slice(0, 2)) lines.push(`  · ${note}`)
  for (const gap of report.platform.targetGaps.slice(0, 3)) lines.push(`  · 画像缺口：${gap}`)
  lines.push(`  短篇集策划视图：情绪 ${formatDistribution(report.planning.emotions)}；反转 ${formatDistribution(report.planning.reversalTypes)}`)
  lines.push(`  结尾味道 ${formatDistribution(report.planning.endingFlavors)}；结构物件 ${formatDistribution(report.planning.structureObjects)}`)
  lines.push(`  反转质量评分：平均 ${avg(report.entries.map((entry) => entry.reversalQuality.score)).toFixed(0)}；弱项 ${report.platform.weakReversals} 篇`)
  for (const entry of report.entries.filter((e) => e.reversalQuality.grade === '弱').slice(0, 3)) {
    lines.push(`  · 第 ${entry.num} 篇「${entry.title}」${entry.reversalQuality.score} 分：${entry.reversalQuality.issues.slice(0, 2).join('；')}`)
  }
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

export function analyzeShortDraftGuidance(
  entries: ShortPieceIndexEntry[],
  shortConfig: BookConfig['short'] | undefined = undefined,
  nextPiece?: number,
): ShortDraftGuidance {
  const report = analyzeShortCollection(entries, shortConfig)
  const avoid = report.risks
    .filter((risk) => risk.kind === 'recent-repeat')
    .slice(0, 4)
    .map((risk) => risk.message.replace(/^最近 3 篇/, '避免继续让最近篇目'))
  const fill = [
    ...missingTargets(report.planning.emotions, report.platformTargets.targetEmotions),
    ...missingTargets(report.planning.reversalTypes, report.platformTargets.targetReversalTypes),
    ...missingTargets(report.planning.endingFlavors, report.platformTargets.targetEndingFlavors),
  ].slice(0, 5)

  return {
    nextPiece: nextPiece ?? ((entries.at(-1)?.num ?? 0) + 1),
    profile: report.platform.profile,
    emphasis: report.platform.emphasis,
    avoid,
    fill,
    checklist: [
      `目标字数 ${report.platform.wordMin}–${report.platform.wordMax}`,
      `开头 ${report.platform.hookWindow} 字内给出人物困境或异常信号`,
      '清单至少 3 个铺垫点，位置需能回指正文段落',
      '伏笔回收必须能对应铺垫点，反转峰值建议 ≥8/10',
    ],
  }
}

export function formatShortDraftGuidance(guidance: ShortDraftGuidance): string {
  const lines: string[] = []
  lines.push('短篇起草前策划导航')
  lines.push('─'.repeat(48))
  lines.push(`  第 ${guidance.nextPiece} 篇画像：${guidance.profile}`)
  lines.push(`  本篇方向：${guidance.emphasis}`)
  if (guidance.avoid.length > 0) {
    lines.push('  避开：')
    for (const item of guidance.avoid) lines.push(`  · ${item}`)
  }
  if (guidance.fill.length > 0) {
    lines.push('  补位：')
    for (const item of guidance.fill) lines.push(`  · ${item}`)
  }
  lines.push('  清单底线：')
  for (const item of guidance.checklist) lines.push(`  · ${item}`)
  lines.push('')
  return lines.join('\n')
}

export function formatShortSubmissionView(
  entries: ShortPieceIndexEntry[],
  shortConfig: BookConfig['short'] | undefined = undefined,
  title = '短篇集',
  platform: ShortSubmissionPlatform = 'generic',
): string {
  const report = analyzeShortCollection(entries, shortConfig)
  const items = entries.map(toSubmissionItem)
  const template = SUBMISSION_TEMPLATES[platform] ?? SUBMISSION_TEMPLATES.generic
  const lines: string[] = []
  lines.push(`# 投稿视图-${title}${platform === 'generic' ? '' : `-${template.label}`}`)
  lines.push('')
  lines.push(`- 平台画像：${report.platform.profile}`)
  lines.push(`- 画像重点：${report.platform.emphasis}`)
  lines.push(`- 平台模板：${template.label}`)
  lines.push(`- 标题风格：${template.titleStyle}`)
  lines.push(`- 简介长度：${template.introLength}`)
  lines.push(`- 卖点字段：${template.sellingPoints.join(' / ')}`)
  lines.push(`- 篇数：${items.length}`)
  lines.push('')
  lines.push('| 篇号 | 标题 | 字数 | 情绪 | 反转类型 | 结尾味道 | 一句卖点 |')
  lines.push('| --- | --- | ---: | --- | --- | --- | --- |')
  for (const item of items) {
    lines.push(`| ${String(item.num).padStart(3, '0')} | ${escapeTable(item.title)} | ${item.words} | ${escapeTable(item.targetEmotion)} | ${escapeTable(item.reversalType)} | ${escapeTable(item.endingFlavor)} | ${escapeTable(item.pitch)} |`)
  }
  lines.push('')
  lines.push('## 策划分布')
  lines.push(`- 情绪：${formatDistribution(report.planning.emotions)}`)
  lines.push(`- 反转：${formatDistribution(report.planning.reversalTypes)}`)
  lines.push(`- 结尾味道：${formatDistribution(report.planning.endingFlavors)}`)
  lines.push(`- 结构物件：${formatDistribution(report.planning.structureObjects)}`)
  lines.push('')
  return lines.join('\n')
}

export function analyzeShortQualityTrend(
  entries: ShortPieceIndexEntry[],
  shortConfig: BookConfig['short'] | undefined = undefined,
  window = 5,
): ShortQualityTrendReport {
  const config = { ...DEFAULT_SHORT_CONFIG, ...shortConfig }
  const sorted = [...entries].sort((a, b) => a.num - b.num)
  const size = Math.max(1, window)
  const recent = sorted.slice(-size)
  const previous = sorted.slice(Math.max(0, sorted.length - size * 2), Math.max(0, sorted.length - size))
  const recentScores = recent.map((entry) => entry.reversalQuality.score)
  const previousScores = previous.map((entry) => entry.reversalQuality.score)
  const recentAvgScore = avg(recentScores)
  const previousAvgScore = previous.length > 0 ? avg(previousScores) : null
  const recentRisks = analyzeShortCollection(recent, config).risks
  const ending = distribution(recent, (entry) => entry.endingFlavor)[0] ?? null
  const wordCounts = recent.map((entry) => entry.wordCount).filter((n) => n > 0)
  const outOfRange = recent.filter((entry) => (
    entry.wordCount > 0
    && (entry.wordCount < (config.word_min ?? 8000) || entry.wordCount > (config.word_max ?? 20000))
  ))
  const weakRecent = recent.filter((entry) => entry.reversalQuality.grade === '弱')
  const signals: string[] = []
  if (previousAvgScore !== null && recentAvgScore + 5 < previousAvgScore) {
    signals.push(`最近 ${recent.length} 篇反转均分下降 ${Math.round(previousAvgScore - recentAvgScore)} 分`)
  }
  if (weakRecent.length > 0) signals.push(`最近窗口有 ${weakRecent.length} 篇弱反转`)
  if (recentRisks.length > 0) signals.push(`最近窗口同质风险 ${recentRisks.length} 项`)
  if (ending && ending.count >= Math.min(3, recent.length) && recent.length >= 3) {
    signals.push(`结尾味道集中在「${ending.value}」`)
  }
  if (outOfRange.length > 0) signals.push(`${outOfRange.length} 篇字数超出画像范围`)

  const notes: string[] = []
  if (entries.length < size) notes.push(`样本 ${entries.length} 篇，小于趋势窗口 ${size}，只做提示不下判决。`)
  if (signals.length === 0 && entries.length > 0) notes.push('最近窗口未见明显质量退化，可继续扩充样本。')
  if (entries.length === 0) notes.push('暂无已定稿短篇，趋势评分待样本生成。')

  return {
    count: entries.length,
    window: size,
    recentAvgScore,
    previousAvgScore,
    direction: trendDirection(recentAvgScore, previousAvgScore),
    recentWordMin: wordCounts.length > 0 ? Math.min(...wordCounts) : 0,
    recentWordMax: wordCounts.length > 0 ? Math.max(...wordCounts) : 0,
    recentEndingFlavor: ending,
    signals,
    notes,
  }
}

export function formatShortQualityTrend(report: ShortQualityTrendReport): string {
  if (report.count === 0) return ''
  const lines: string[] = []
  lines.push('短篇质量趋势评分')
  lines.push('─'.repeat(48))
  lines.push(`  样本 ${report.count} 篇；窗口 ${report.window} 篇；最近反转均分 ${report.recentAvgScore.toFixed(0)}（${report.direction}）`)
  if (report.previousAvgScore !== null) lines.push(`  上一窗口均分 ${report.previousAvgScore.toFixed(0)}`)
  if (report.recentWordMin > 0) lines.push(`  最近窗口字数范围 ${report.recentWordMin}–${report.recentWordMax}`)
  if (report.recentEndingFlavor) lines.push(`  最近结尾味道：${report.recentEndingFlavor.value}×${report.recentEndingFlavor.count}`)
  if (report.signals.length === 0) {
    lines.push('  ✓ 暂未发现明显趋势退化')
  } else {
    for (const signal of report.signals.slice(0, 5)) lines.push(`  · ${signal}`)
  }
  for (const note of report.notes.slice(0, 3)) lines.push(`  · ${note}`)
  lines.push('')
  return lines.join('\n')
}

export function analyzeShortSeriesMotifs(
  entries: ShortPieceIndexEntry[],
  shortConfig: BookConfig['short'] | undefined = undefined,
): ShortSeriesMotifReport {
  const declaredMotifs = (shortConfig?.series_motifs ?? []).map((motif) => motif.trim()).filter(Boolean)
  const observedMotifs = distribution(
    entries.flatMap((entry) => entry.structureObjects.map((motif) => ({ ...entry, motif }))),
    (entry) => entry.motif,
  )
  const observedKeys = new Set(observedMotifs.map((item) => normalize(item.value)))
  const underusedMotifs = declaredMotifs.filter((motif) => !observedKeys.has(normalize(motif)))
  const repeatedMotifs = observedMotifs.filter((item) => item.count >= 2)
  const notes: string[] = []
  if (declaredMotifs.length === 0) {
    notes.push('未声明 series_motifs；可在 book.yaml short 中列共享地点、传说或物件。')
  }
  if (declaredMotifs.length > 0 && underusedMotifs.length === 0) {
    notes.push('声明母题均已在定稿短篇中出现。')
  }
  if (repeatedMotifs.length > 0) {
    notes.push('重复母题只做系列化提示，不等同于短篇账本。')
  }
  return {
    count: entries.length,
    declaredMotifs,
    observedMotifs,
    underusedMotifs,
    repeatedMotifs,
    notes,
  }
}

export function formatShortSeriesMotifs(report: ShortSeriesMotifReport): string {
  if (report.count === 0 && report.declaredMotifs.length === 0) return ''
  const lines: string[] = []
  lines.push('短篇系列母题')
  lines.push('─'.repeat(48))
  lines.push(`  声明母题：${report.declaredMotifs.length > 0 ? report.declaredMotifs.join(' / ') : '暂无'}`)
  lines.push(`  观察母题：${formatDistribution(report.observedMotifs)}`)
  if (report.underusedMotifs.length > 0) {
    lines.push(`  未使用：${report.underusedMotifs.slice(0, 5).join(' / ')}`)
  }
  if (report.repeatedMotifs.length > 0) {
    lines.push(`  可系列化：${report.repeatedMotifs.slice(0, 5).map((item) => `${item.value}（篇 ${item.pieces.join('、')}）`).join('；')}`)
  }
  for (const note of report.notes.slice(0, 3)) lines.push(`  · ${note}`)
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
  const completeRecords = shortRecords.filter(hasCompleteAccounting)
  const totals = completeRecords.map((r) => r.calls.total).sort((a, b) => a - b)
  const avgCalls = avg(totals)
  const p80Calls = percentile(totals, 0.8)
  const p90Calls = percentile(totals, 0.9)
  const recommendedLimit = totals.length < 3
    ? currentLimit
    : clamp(Math.max(3, Math.ceil(p90Calls) + 1), 3, 20)
  return {
    count: shortRecords.length,
    usableCount: completeRecords.length,
    currentLimit,
    avgCalls,
    p80Calls,
    p90Calls,
    recommendedLimit,
    overLimit: completeRecords.filter((r) => r.calls.total > r.calls.limit).length,
    nearLimit: completeRecords.filter((r) => r.calls.limit > 0 && r.calls.total >= r.calls.limit * 0.8).length,
    missingAccounting: shortRecords.length - completeRecords.length,
  }
}

export function formatShortBudgetCalibrationReport(report: ShortBudgetCalibrationReport): string {
  if (report.count === 0) return ''
  const lines: string[] = []
  lines.push('短篇预算校准建议')
  lines.push('─'.repeat(48))
  lines.push(`  样本 ${report.count} 篇（完整记账 ${report.usableCount} 篇）：平均 ${report.avgCalls.toFixed(1)} 次/篇，P80 ${report.p80Calls.toFixed(1)}，P90 ${report.p90Calls.toFixed(1)}`)
  if (report.usableCount < 3) {
    lines.push(`  当前 calls_per_chapter ${report.currentLimit}；完整样本不足，暂不输出候选`)
  } else {
    lines.push(`  当前 calls_per_chapter ${report.currentLimit}；建议候选 ${report.recommendedLimit}`)
  }
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

export function analyzeShortRepairPlan(
  entries: ShortPieceIndexEntry[],
  shortConfig: BookConfig['short'] | undefined = undefined,
  records: MetricRecord[] = [],
): ShortRepairPlanReport {
  const config = { ...DEFAULT_SHORT_CONFIG, ...shortConfig }
  const collection = analyzeShortCollection(entries, config)
  const metricByNum = new Map(records.filter((r) => r.kind === 'short').map((r) => [r.num, r]))
  const items = entries
    .map((entry) => buildRepairPlanItem(entry, collection.risks, metricByNum.get(entry.num), config))
    .filter((item): item is ShortRepairPlanItem => item !== null)
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.score - b.score || a.num - b.num)

  const collectionActions = collection.risks
    .slice(0, 5)
    .map((risk) => `${risk.message}：${riskAction(risk.field)}`)

  const notes: string[] = []
  if (collection.platform.targetGaps.length > 0) {
    notes.push(`后续新稿优先补画像缺口：${collection.platform.targetGaps.slice(0, 3).join('、')}`)
  }
  if (collection.platform.weakReversals > 0) {
    notes.push(`${collection.platform.weakReversals} 篇反转质量偏弱，先修高优先级篇，再开新篇。`)
  }
  if (entries.length > 0 && items.length === 0) {
    notes.push('当前短篇集未发现明确返修项，可继续扩充真实样本回归集。')
  }

  return { count: entries.length, items, collectionActions, notes }
}

export function formatShortRepairPlan(report: ShortRepairPlanReport): string {
  if (report.count === 0) {
    return '短篇重修计划\n────────────────────────────────────────────────\n  尚无已定稿短篇。先完成定稿，再从 health --report 进入重修。\n\n'
  }

  const lines: string[] = []
  lines.push('短篇重修计划')
  lines.push('─'.repeat(48))
  lines.push(`  样本 ${report.count} 篇；重修候选 ${report.items.length} 篇`)
  if (report.items.length === 0) {
    lines.push('  ✓ 暂无明确重修项')
  } else {
    for (const item of report.items.slice(0, 8)) {
      lines.push(`  【${item.priority}】第 ${item.num} 篇「${item.title}」 · 反转 ${item.score} 分`)
      lines.push(`    弱项：${item.reasons.slice(0, 4).join('；')}`)
      lines.push(`    动作：${item.actions.slice(0, 4).join('；')}`)
    }
  }
  if (report.collectionActions.length > 0) {
    lines.push('  集级动作：')
    for (const action of report.collectionActions.slice(0, 4)) lines.push(`  · ${action}`)
  }
  for (const note of report.notes.slice(0, 3)) lines.push(`  · ${note}`)
  lines.push('')
  return lines.join('\n')
}

function hasCompleteAccounting(record: MetricRecord): boolean {
  if (record.calls.total <= 0) return false
  if (record.calls.outline <= 0) return false
  if (record.calls.draft <= 0) return false
  if (record.review !== null && record.calls.review <= 0) return false
  return true
}

function buildRepairPlanItem(
  entry: ShortPieceIndexEntry,
  risks: ShortCollectionRisk[],
  record: MetricRecord | undefined,
  config: NonNullable<BookConfig['short']>,
): ShortRepairPlanItem | null {
  const issues: ShortRepairPlanIssue[] = []
  for (const issue of entry.reversalQuality.issues) {
    issues.push({ reason: issue, action: actionForReversalIssue(issue) })
  }
  if (entry.wordCount > 0 && entry.wordCount < (config.word_min ?? 8000)) {
    issues.push({
      reason: `字数 ${entry.wordCount} 低于画像下限 ${config.word_min ?? 8000}`,
      action: '补足反转前因、人物动机和结尾回味，不只加描写字数',
    })
  }
  if (entry.wordCount > (config.word_max ?? 20000)) {
    issues.push({
      reason: `字数 ${entry.wordCount} 超过画像上限 ${config.word_max ?? 20000}`,
      action: '压缩重复铺陈，必要时拆成两篇独立闭环',
    })
  }

  for (const risk of risks.filter((r) => r.pieces.includes(entry.num)).slice(0, 3)) {
    issues.push({ reason: risk.message, action: riskAction(risk.field) })
  }

  if (record) {
    if (record.review === null) {
      issues.push({ reason: '缺少三审指标', action: '补跑 review run/collect，再看阻断项是否仍存在' })
    } else {
      if (record.review.blockers > 0) {
        issues.push({ reason: `三审阻断项 ${record.review.blockers} 个`, action: '先逐条消除阻断项，再重跑 review collect' })
      }
      if (record.review.downgrade) {
        issues.push({
          reason: `审查降级：${record.review.downgrade_reason ?? '未记录原因'}`,
          action: '补齐缺失审查视角，避免用降级结论直接定稿',
        })
      }
      if (record.review.warnings >= 3) {
        issues.push({ reason: `三审警告 ${record.review.warnings} 个`, action: '集中处理重复出现的黄项，再做一次轻量复审' })
      }
    }
    if (record.calls.total > record.calls.limit) {
      issues.push({ reason: `AI 调用 ${record.calls.total}/${record.calls.limit} 超预算`, action: '复盘 outline/draft/review 哪一步返工最多，收窄下一轮改稿范围' })
    }
  }

  const uniqueIssues = dedupeIssues(issues)
  if (uniqueIssues.length === 0) return null
  const priority = entry.reversalQuality.grade === '弱' || uniqueIssues.some((i) => /阻断|降级|核心反转/.test(i.reason))
    ? '高'
    : entry.reversalQuality.grade === '中' || uniqueIssues.length >= 2
      ? '中'
      : '低'
  return {
    num: entry.num,
    title: entry.title,
    priority,
    score: entry.reversalQuality.score,
    reasons: uniqueIssues.map((i) => i.reason),
    actions: uniqueIssues.map((i) => i.action),
  }
}

function dedupeIssues(issues: ShortRepairPlanIssue[]): ShortRepairPlanIssue[] {
  const seen = new Set<string>()
  const out: ShortRepairPlanIssue[] = []
  for (const issue of issues) {
    const key = `${issue.reason}\n${issue.action}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(issue)
  }
  return out
}

function actionForReversalIssue(issue: string): string {
  if (issue.includes('核心反转')) return '先重写一句核心反转，让真相、误导对象和情绪落点都可验证'
  if (issue.includes('有效铺垫点')) return '补足至少 3 个可回溯铺垫，分别放在开头、升级和反转前'
  if (issue.includes('正文锚点')) return '给铺垫位置补正文 ## 段落锚点，让清单能回指具体段落'
  if (issue.includes('未回收')) return '把未回收伏笔改成明确回收位置，或从清单删除无效伏笔'
  if (issue.includes('回收条目')) return '让回收条目复用铺垫关键词，避免伏笔链路松散'
  if (issue.includes('反转峰值') || issue.includes('情绪曲线')) return '重写反转段情绪曲线，把爆点强度推到 8/10 以上'
  if (issue.includes('伏笔回收为空')) return '新增伏笔回收表，至少闭合一个关键物件或一句误导'
  return '按该弱项重写清单，再同步修改正文对应段落'
}

function riskAction(field: ShortCollectionRisk['field']): string {
  if (field === 'targetEmotion') return '换一篇的目标情绪或追加反向情绪，让相邻篇读感错开'
  if (field === 'reversalType') return '改其中一篇的反转机制，避免连续使用同一种真相揭露'
  if (field === 'endingFlavor') return '重写结尾余味，至少让一篇从后怕/释然/遗憾中换档'
  if (field === 'coreReversal') return '保留题材外壳，替换真相主体或误导视角'
  return '替换重复结构物件，给新物件绑定铺垫和回收'
}

function priorityRank(priority: ShortRepairPlanItem['priority']): number {
  if (priority === '高') return 0
  if (priority === '中') return 1
  return 2
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

function scoreReversalQuality(coreReversal: string, list: PieceList | null, body = ''): ShortReversalQuality {
  const issues: string[] = []
  const setups = list?.反转线索表.铺垫点 ?? []
  const realSetups = setups.filter((p) => !isPlaceholder(p.内容))
  const uniqueSetupCount = new Set(realSetups.map((p) => normalize(p.内容))).size
  const anchors = collectBodyAnchors(body)
  const anchoredSetupCount = realSetups.filter((p) => setupHasAnchor(p.位置, anchors)).length
  const payoffs = list?.伏笔回收 ?? []
  const payoffOpen = payoffs.filter((p) => p.未回收 || isPlaceholder(p.回收位置)).length
  const payoffClosed = payoffs.length - payoffOpen
  const payoffMatched = payoffs.filter((p) => payoffMatchesSetup(p.伏笔, realSetups)).length
  const peakStrength = reversalPeakStrength(list)

  let score = 0
  if (isPlaceholder(coreReversal)) {
    issues.push('核心反转未落成')
  } else {
    score += 30
  }
  score += Math.min(25, uniqueSetupCount * 8)
  if (uniqueSetupCount < 3) issues.push(`有效铺垫点 ${uniqueSetupCount}/3，不足以支撑公平反转`)
  if (anchors.length > 0) {
    score += Math.min(10, anchoredSetupCount * 3)
    if (anchoredSetupCount < Math.min(3, realSetups.length)) issues.push(`铺垫正文锚点 ${anchoredSetupCount}/${realSetups.length}，位置回指不足`)
  } else if (realSetups.length > 0) {
    score += 4
    issues.push('正文缺少 ## 段落锚点，铺垫位置只能做弱校验')
  }
  if (payoffs.length === 0) {
    score += 6
    issues.push('伏笔回收为空，收尾闭合证据不足')
  } else if (payoffOpen === 0) {
    score += 20
  } else {
    score += Math.max(0, 20 - payoffOpen * 8)
    issues.push(`${payoffOpen} 个伏笔未回收`)
  }
  if (payoffs.length > 0) {
    score += Math.min(10, payoffMatched * 4)
    if (payoffMatched < payoffClosed) issues.push(`回收条目 ${payoffMatched}/${payoffClosed} 能对应铺垫，伏笔链路偏松`)
  }
  if (peakStrength === null) {
    score += 5
    issues.push('情绪曲线缺少反转峰值')
  } else if (peakStrength >= 8) {
    score += 15
  } else {
    score += Math.max(0, peakStrength)
    issues.push(`反转峰值 ${peakStrength}/10，爆点偏弱`)
  }
  if (uniqueSetupCount >= 3 && payoffOpen === 0 && !isPlaceholder(coreReversal)) score += 10
  const finalScore = clamp(Math.round(score), 0, 100)
  return {
    score: finalScore,
    grade: finalScore >= 80 ? '强' : finalScore >= 60 ? '中' : '弱',
    setupCount: uniqueSetupCount,
    anchoredSetupCount,
    payoffClosed,
    payoffOpen,
    payoffMatched,
    peakStrength,
    issues,
  }
}

function collectBodyAnchors(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.match(/^##\s+(.+)$/)?.[1]?.trim() ?? '')
    .filter(Boolean)
}

function setupHasAnchor(position: string, anchors: string[]): boolean {
  const pos = normalize(position)
  if (!pos || isPlaceholder(position)) return false
  if (anchors.length === 0) return true
  return anchors.some((anchor) => {
    const a = normalize(anchor)
    return a.includes(pos) || pos.includes(a)
  })
}

function payoffMatchesSetup(payoff: string, setups: SetupPoint[]): boolean {
  const p = normalize(payoff)
  if (!p || isPlaceholder(payoff)) return false
  return setups.some((setup) => {
    const s = normalize(setup.内容)
    return s.includes(p) || p.includes(s)
  })
}

function reversalPeakStrength(list: PieceList | null): number | null {
  const curve = list?.情绪曲线 ?? []
  if (curve.length === 0) return null
  const reversalPoint = curve.find((p) => /反转|真相|揭露|爆点/.test(p.段落))
  if (reversalPoint) return reversalPoint.强度
  return Math.max(...curve.map((p) => p.强度))
}

function analyzePlatformProfile(
  entries: ShortPieceIndexEntry[],
  config: NonNullable<BookConfig['short']>,
): ShortPlatformProfileReport {
  const profile = config.profile || '通用短篇'
  const notes: string[] = []
  const targets = platformTargetsOf(config)
  const planning = analyzePlanningView(entries)
  const avgWords = avg(entries.map((entry) => entry.wordCount))
  const weakReversals = entries.filter((entry) => entry.reversalQuality.grade === '弱').length
  if (entries.length > 0 && avgWords > (config.word_max ?? 20000)) notes.push(`平均字数 ${avgWords.toFixed(0)} 超过画像上限，适合拆篇或压缩铺陈。`)
  if (entries.length > 0 && avgWords < (config.word_min ?? 8000)) notes.push(`平均字数 ${avgWords.toFixed(0)} 低于画像下限，反转前因后果可能偏薄。`)
  if (weakReversals > 0) notes.push(`${weakReversals} 篇反转质量偏弱，优先补铺垫/回收/峰值。`)
  if (notes.length === 0) notes.push('当前样本与画像约束基本贴合，可继续观察分布重复。')
  return {
    profile,
    wordMin: config.word_min ?? 8000,
    wordMax: config.word_max ?? 20000,
    hookWindow: config.opening_env_chars ?? 300,
    emphasis: profileEmphasis(profile),
    avgWords,
    weakReversals,
    targetGaps: [
      ...missingTargets(planning.emotions, targets.targetEmotions).map((item) => `情绪 ${item}`),
      ...missingTargets(planning.reversalTypes, targets.targetReversalTypes).map((item) => `反转 ${item}`),
      ...missingTargets(planning.endingFlavors, targets.targetEndingFlavors).map((item) => `结尾 ${item}`),
    ],
    notes,
  }
}

function platformTargetsOf(config: NonNullable<BookConfig['short']>): ShortPlatformTargets {
  return {
    targetEmotions: config.target_emotions ?? [],
    targetReversalTypes: config.target_reversal_types ?? [],
    targetEndingFlavors: config.target_ending_flavors ?? [],
  }
}

function profileEmphasis(profile: string): string {
  if (/悬疑|怪谈|推理|惊悚/.test(profile)) return '强钩子、可回溯铺垫、结尾后怕'
  if (/爽|打脸|复仇|逆袭/.test(profile)) return '快开局、连续爽点、反转后即时清算'
  if (/情感|治愈|言情|余韵/.test(profile)) return '情绪递进、关系真相、余韵闭合'
  if (/设定|科幻|奇观|玄幻|奇幻/.test(profile)) return '规则亮相、设定反转、物件闭环'
  return '单篇闭环、一反转撑全篇、避免相邻篇同质'
}

function analyzePlanningView(entries: ShortPieceIndexEntry[]): ShortPlanningView {
  return {
    emotions: distribution(entries, (entry) => entry.targetEmotion),
    reversalTypes: distribution(entries, (entry) => entry.reversalType),
    endingFlavors: distribution(entries, (entry) => entry.endingFlavor),
    structureObjects: distribution(
      entries.flatMap((entry) => entry.structureObjects.map((object) => ({ ...entry, object }))),
      (entry) => entry.object,
    ),
  }
}

function distribution<T extends { num: number }>(items: T[], valueOf: (item: T) => string): DistributionItem[] {
  const grouped = groupBy(items, (item) => normalize(valueOf(item)))
  return [...grouped.entries()]
    .map(([_, group]) => ({
      value: cleanValue(valueOf(group[0]!)) || '未知',
      count: group.length,
      pieces: [...new Set(group.map((item) => item.num))],
    }))
    .filter((item) => item.value !== '未知')
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans'))
    .slice(0, 5)
}

function formatDistribution(items: DistributionItem[]): string {
  if (items.length === 0) return '暂无'
  return items.slice(0, 3).map((item) => `${item.value}×${item.count}`).join(' / ')
}

function missingTargets(distributionItems: DistributionItem[], targets: string[]): string[] {
  if (targets.length === 0) return []
  const seen = new Set(distributionItems.map((item) => normalize(item.value)))
  return targets.filter((target) => !seen.has(normalize(target))).slice(0, 3)
}

function toSubmissionItem(entry: ShortPieceIndexEntry): ShortSubmissionItem {
  const targetEmotion = entry.targetEmotion || '未标注'
  const reversalType = entry.reversalType || '未知'
  const endingFlavor = entry.endingFlavor || '未标注'
  const pitch = entry.coreReversal
    ? `${targetEmotion}走向，核心反转：${entry.coreReversal}`
    : `${targetEmotion}走向，核心反转待补`
  return {
    num: entry.num,
    title: entry.title,
    words: entry.wordCount,
    targetEmotion,
    reversalType,
    endingFlavor,
    pitch,
  }
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, '/').replace(/\n/g, ' ')
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

function trendDirection(recent: number, previous: number | null): ShortQualityTrendReport['direction'] {
  if (previous === null) return '样本不足'
  if (recent >= previous + 5) return '上升'
  if (recent + 5 < previous) return '下降'
  return '持平'
}
