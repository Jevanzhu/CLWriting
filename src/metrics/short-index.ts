/**
 * 短篇集级索引与重复风险体检。
 *
 * 目标：短篇主链已按单篇闭环，本模块只做整集层面的轻量扫描。
 * 数据来自已定稿 `篇/<篇号>-<标题>.md` 与 `清单/<篇号>-<标题>.md`，
 * 不写文件、不耗模型，用于 health --report 的短篇集节奏提示。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readPiece } from '../format/pieces.js'
import { readPieceList } from '../format/manifest.js'
import { readFile } from '../format/frontmatter.js'
import { countWords } from '../format/chapters.js'
import type { BookConfig, PieceList, SetupPoint } from '../format/types.js'
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
  const 清单Dir = join(bookRoot, '清单')
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
    if (!/^\d+-.*\.md$/.test(name)) continue
    const bodyPath = join(piecesDir, name)
    if (!existsSync(bodyPath)) continue

    const piece = readPiece(bodyPath)
    if (!piece.ok) continue
    const file = readFile(bodyPath)
    const list = readListIfExists(join(清单Dir, name))
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

function readListIfExists(path: string): PieceList | null {
  if (!existsSync(path)) return null
  const r = readPieceList(path)
  return r.ok ? r.list : null
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((sum, n) => sum + n, 0) / nums.length
}

