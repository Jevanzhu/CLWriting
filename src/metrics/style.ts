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

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { readChapterDir } from '../format/chapters.js'
import { splitSentences, ngramRepeatRate } from '../format/sentences.js'
import { finalizedPathSet } from '../document/manifest.js'
import { docJoinKey } from '../fs/safe-path.js'
import { atomicWriteFile } from '../fs/atomic.js'
import { readSamplesByScene } from '../format/style.js'
import { readEntries, ENTRIES_DIR } from '../format/style-entry.js'
import { readFile } from '../format/frontmatter.js'
import { readIronRules, type IronRules } from '../format/iron-rules.js'
import { computeStyleMetrics, type StyleStats } from '../check/count.js'
import type { ChapterMeta } from '../format/types.js'

/** 含句长方差/复读率的完整文风指纹（StyleStats + 两个聚合用维度） */
export interface FullStyleStats extends StyleStats {
  sentenceLenVariance: number
  repeatRate: number
  /** R75-1（批 A）：计数维归一化因子——该指纹对应正文的码点数。adjStackHits 等计数维
   *  随文本长度近似线性增长，跨长度对比（单章 vs 拼接语料基线）须除以自身 charCount
   *  归一成密度（次/千字）再比，否则量纲错配稳定产假阳。
   *  可选字段：v1 基线可能冻结于本字段引入前，缺失 = 旧基线，消费方须降级（跳过计数维
   *  密度比较），不得伪造 0/1 等值参与计算。 */
  charCount?: number
}

/** 基线指纹（文风方案 §5.2，byScene + overall）。version 1 持续兼容：字段只增不改，
 *  旧文件缺新字段（如 R75-1 的 charCount）由 coerceStats 容忍保留缺失语义。 */
export interface StyleBaseline {
  version: number
  frozenAt: string
  frozenFrom: string
  byScene: Record<string, FullStyleStats>
  overall: FullStyleStats
}

/** 单章文风采样 */
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

/** 文风基线路径（进 git，作者可手改） */
export function baselinePath(bookRoot: string): string {
  return join(bookRoot, '文风', '基线.json')
}

/** 读铁律阈值 + 条目库禁词合并（S5 收口：禁词知识在条目库，铁律瘦身为纯配置）；皆无 → 空规则。
 *  RB-KN-P1-1：实现下沉 format/iron-rules.ts 单一真相源（check/runner 与本模块共用，
 *  原先 runner 用私有不合并版，迁移书禁词红项失效）——此处转发导出保持既有 import 兼容。 */
export { readIronRules }

/**
 * 读一章正文的 body（readChapterDir 返回 ChapterMeta 不含 body，订正第 4 条）。
 * 复用 frontmatter.readFile 剥 front matter。文件缺失/坏 → 返回 null。
 */
// R66-24（十四轮）：章正文指纹缓存（abs path → mtimeNs+size 指纹 + 去 fm 正文）。
// 文风重扫（scanChapters → readChapterBody）此前每次调用逐章整读全文零缓存——
// health/文风视图每开一次全书重读（与 R66-6 伏笔同族）；按 stat 指纹缓存后未变
// 章节零重读。纪律对齐 document/tree.ts probeCache 与 format/chapters.ts
// chapterDirCache：bigint stat（mtimeNs + size）、Map 插入序 FIFO 上限、失配自失效。
const CHAPTER_BODY_CACHE_MAX = 4096
const chapterBodyCache = new Map<string, { mtimeNs: bigint; size: bigint; body: string }>()

/** 读章正文（带 stat 指纹缓存：未变 → 复用零读，变更/删除 → 重读或清条目）。
 *  R66-24：metrics/short-index.ts 短篇集索引同走本缓存（原 readChapterDir
 *  includeBody 现读通道改为缓存 meta + 缓存 body）。 */
export function readChapterBody(chapter: ChapterMeta): string | null {
  if (!chapter._path) return null
  let st: { mtimeNs: bigint; size: bigint }
  try {
    st = statSync(chapter._path, { bigint: true })
  } catch {
    chapterBodyCache.delete(chapter._path)
    return null // 文件消失（TOCTOU）：按无正文降级（原 readFile 失败同口径）
  }
  const hit = chapterBodyCache.get(chapter._path)
  if (hit && hit.mtimeNs === st.mtimeNs && hit.size === st.size) return hit.body
  const r = readFile(chapter._path)
  if (!r.ok) return null
  // FIFO 淘汰最旧（Map 保插入序，防长跑无界）
  if (chapterBodyCache.size >= CHAPTER_BODY_CACHE_MAX) {
    const oldest = chapterBodyCache.keys().next().value
    if (oldest !== undefined) chapterBodyCache.delete(oldest)
  }
  chapterBodyCache.set(chapter._path, { mtimeNs: st.mtimeNs, size: st.size, body: r.body })
  return r.body
}

/** 句长方差（与 count.ts checkSentenceLength 同口径：按 。！？\n 切句算方差）。
 *  R35-23（三十五轮）：句长改码点口径（R73-19/R75-1 同家族）——UTF-16 .length 对
 *  astral 字符一符计 2、句长虚高，与同文件 charCount（码点）及 count.ts 超长句判定
 *  单位分裂；基线与实时检查须同 metric 同单位。 */
export function computeSentenceLenVariance(body: string): number {
  const sentences = splitSentences(body)
  if (sentences.length === 0) return 0
  const lens = sentences.map((s) => charCountOf(s))
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length
  const variance = lens.reduce((sum, len) => sum + (len - mean) ** 2, 0) / lens.length
  return variance
}

/** 复读率（M-12·第八轮：真正与 count.ts checkRepeat 同口径——此前注释宣称滑窗 n-gram、
 *  实现却是整句哈希（句长 ≥6 vs ≥8、分母为句数），复读率系统性低估）。 */
export function computeRepeatRate(body: string): number {
  return ngramRepeatRate(body).rate
}

/** R75-1（批 A）：码点计数（代理对合 1 计），与 check/count.ts 的 codePointLength
 *  同口径手写遍历——该函数未导出，且 metrics→process（summary）→ai→metrics 会成环，
 *  故本地同款不引依赖（全库 code point 口径第 5 处，P-7/R73-19 家族）。 */
function charCountOf(body: string): number {
  let n = 0
  for (let i = 0; i < body.length; i++) {
    n++
    if (body.codePointAt(i)! > 0xffff) i++ // 代理对：astral 字符按 1 计
  }
  return n
}

/** 对一段正文算完整文风指纹（StyleStats 5 维 + 句长方差 + 复读率）。
 *  R75-1：附带 charCount 归一化因子（新冻结的基线随之持久化该字段）。 */
export function computeFullStats(body: string, rules: IronRules): FullStyleStats {
  return {
    ...computeStyleMetrics(body, rules),
    sentenceLenVariance: computeSentenceLenVariance(body),
    repeatRate: computeRepeatRate(body),
    charCount: charCountOf(body),
  }
}

/**
 * 重扫：扫 写作/正文/（递归卷目录）逐章算指纹，按章号排序。
 * M-11（第八轮）：只收定稿章——此前不过滤 finalized，在写草稿计入样本：health 文风
 * 趋势被草稿污染、style-harvest 据草稿漂移产候选，违背 learn H-1「草稿不进候选池」
 * 红线。判定与 learn/导出同一函数（manifest.finalizedPathSet，曾定稿=过）；旧书无
 * 清单 → null 无法判定，保持全量（与 learn/导出降级一致）。
 */
export function scanChapters(bookRoot: string): ChapterSample[] {
  const textDir = join(bookRoot, '写作', '正文')
  const rules = readIronRules(bookRoot)
  const finalized = finalizedPathSet(bookRoot)
  // R42-6（四十二轮）：定稿集消费侧折叠键集（win32 大小写 + NFC，overview.ts R41-2
  // 同款范式）——case-only 改名 / NFD 文件名后精确串失配，定稿章被误跳 → 文风样本缺章
  const finalizedKeys = finalized === null ? null : new Set([...finalized].map(docJoinKey))
  const { chapters } = readChapterDir(textDir)
  const samples: ChapterSample[] = []
  for (const ch of chapters) {
    if (finalizedKeys && ch._path && !finalizedKeys.has(docJoinKey(relative(bookRoot, ch._path)))) continue // R42-6：折叠键比较（relPathKey 已归一分隔符）
    const body = readChapterBody(ch)
    if (body === null) continue
    samples.push({ num: ch.章号, title: ch.标题, stats: computeFullStats(body, rules) })
  }
  return samples.sort((a, b) => a.num - b.num)
}

// R40-4（四十轮）：scanChapters 的异步孪生——读循环每 25 章让出一次事件循环。
// 对齐 R39-15（analysis.ts MISS 读循环）/R72-2（learn 章级让出）范式：health 缓存
// miss 与收割源2 挂在 HTTP 链上此前同步整树扫描，200 万字大书秒级冻结事件循环
// （SSE 心跳/保存/全部 API 同停）。章正文读有 R66-24 stat 指纹缓存，但 miss 首扫
// 与逐章 computeFullStats 仍为热点。yield 助手本地定义（learn/index.ts 同款先例：
// metrics 层不向上引 studio/server/api/progress，防反向依赖）。
const SCAN_YIELD_EVERY = 25
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** scanChapters 的异步孪生（R40-4）——语义与同步版逐字段一致（等价性对照测试锚定），
 *  供 HTTP 链（health miss / 收割源2）使用；同步版保留供存量测试与非 HTTP 调用方。 */
export async function scanChaptersAsync(bookRoot: string): Promise<ChapterSample[]> {
  const textDir = join(bookRoot, '写作', '正文')
  const rules = readIronRules(bookRoot)
  const finalized = finalizedPathSet(bookRoot)
  // R42-6（四十二轮）：同 scanChapters 折叠键集（语义与同步版逐字段一致）
  const finalizedKeys = finalized === null ? null : new Set([...finalized].map(docJoinKey))
  const { chapters } = readChapterDir(textDir)
  const samples: ChapterSample[] = []
  let scanned = 0
  for (const ch of chapters) {
    if (finalizedKeys && ch._path && !finalizedKeys.has(docJoinKey(relative(bookRoot, ch._path)))) continue // R42-6：折叠键比较
    const body = readChapterBody(ch)
    if (body === null) continue
    samples.push({ num: ch.章号, title: ch.标题, stats: computeFullStats(body, rules) })
    if (++scanned % SCAN_YIELD_EVERY === 0) await yieldToEventLoop()
  }
  return samples.sort((a, b) => a.num - b.num)
}

/**
 * 跨章聚合 + 漂移判定。
 * 漂移判定原则（只报趋势不下判决）：单点偶发不报，连续/趋势才报。
 * 短篇 < SHORT_TREND_MIN 章 → 不做趋势判定（诚实降级，文风方案 §4.5）。
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
      'dialogueTag',
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

/** 检测连续 N 个超阈值的点，返回漂移信号。metricKey 贴到 drift.metric（泛化用） */
function detectConsecutiveOver(
  series: number[],
  nums: number[],
  threshold: number,
  window: number,
  msg: string,
  metricKey: string,
): StyleDrift[] {
  let streak = 0
  let streakStart = -1
  for (let i = 0; i < series.length; i++) {
    if (series[i]! > threshold) {
      if (streak === 0) streakStart = nums[i]!
      streak++
      if (streak >= window) {
        return [{ metric: metricKey, message: `${msg}（起于第 ${streakStart} 章）` }]
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

/** 冻结基线：样章按场景算指纹 → 写 文风/基线.json（幂等覆盖）。
 *  条目库存在走样章条目（S7 收口，迁移后唯一真相），否则旧样章库目录。
 *  无有效样章 → 抛错不写文件（诚实，不伪装）。返回冻结的基线。 */
export function freezeBaseline(bookRoot: string): StyleBaseline {
  const rules = readIronRules(bookRoot)
  const byScene: Record<string, FullStyleStats> = {}
  const allBodies: { scene: string; body: string }[] = []
  let frozenFrom = '文风/样章库'

  const entriesDir = join(bookRoot, ENTRIES_DIR)
  if (existsSync(entriesDir)) {
    // 新路：条目库样章按 场景 字段分组
    frozenFrom = `${ENTRIES_DIR}/样章`
    const { entries } = readEntries(entriesDir, '样章')
    const groups = new Map<string, string[]>()
    for (const e of entries) {
      const scene = e.场景 || '通用'
      groups.set(scene, [...(groups.get(scene) ?? []), e.正文])
    }
    for (const [scene, bodies] of groups) {
      byScene[scene] = computeFullStats(bodies.join('\n\n'), rules)
      for (const body of bodies) allBodies.push({ scene, body })
    }
    if (Object.keys(byScene).length === 0) {
      throw new Error('条目库没有样章条目（文风/条目/样章/），先收录样章再冻结基线')
    }
  } else {
    // 旧路：未迁移的书扫样章库场景目录
    const sampleDir = join(bookRoot, '文风', '样章库')
    let sceneEntries: string[]
    try {
      // 低级项（第六轮）：显式排序——readdir 顺序随平台漂移，冻结基线需跨平台可复现
      sceneEntries = readdirSync(sampleDir).filter((n) => !n.startsWith('._')).sort()
    } catch {
      throw new Error('样章库目录不存在（文风/样章库/），无法冻结基线')
    }
    let invalidSampleCount = 0
    for (const scene of sceneEntries) {
      const scenePath = join(sampleDir, scene)
      // dd-P3：readdir 后目录可能被删——statSync 用 throwIfNoEntry 容错，防裸 ENOENT 中断冻结
      const st = statSync(scenePath, { throwIfNoEntry: false })
      if (!st || !st.isDirectory()) continue
      const { samples, errors } = readSamplesByScene(sampleDir, scene)
      invalidSampleCount += errors.length
      if (samples.length === 0) continue // 空场景目录跳过
      const combined = samples.map((s) => s.正文).join('\n\n')
      byScene[scene] = computeFullStats(combined, rules)
      for (const s of samples) allBodies.push({ scene, body: s.正文 })
    }
    if (Object.keys(byScene).length === 0) {
      if (invalidSampleCount > 0) {
        throw new Error('样章库没有有效样章：样章必须放在 文风/样章库/<场景>/<场景>-001.md，且 front matter 至少包含「场景: <场景>」。')
      }
      throw new Error('样章库为空（无有效样章），无法冻结基线')
    }
  }

  const overallBody = allBodies.map((b) => b.body).join('\n\n')
  const baseline: StyleBaseline = {
    version: 1,
    frozenAt: new Date().toISOString(),
    frozenFrom,
    byScene,
    overall: computeFullStats(overallBody, rules),
  }

  const p = baselinePath(bookRoot)
  mkdirSync(dirname(p), { recursive: true })
  // N-12（第十二轮）：冻结基线是重建成本最高的落盘之一（全库样章统计），对齐
  // service 元数据写的 fsync: true 口径——断电窗口内 rename 只进页缓存会丢基线
  atomicWriteFile(p, JSON.stringify(baseline, null, 2), { fsync: true })
  return baseline
}

// ── 格式化 ────────────────────────────────────────

/** 重扫报告 → 人话表格（文风方案 §4.4 输出形态） */
export function formatStyleReport(trend: StyleTrend): string {
  if (trend.count === 0) {
    return '尚无已定稿正文可重扫。写完并定稿一章后再看（health --style）。\n'
  }
  const unit = '章'
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
    lines.push(`（短篇 ${trend.count} 章 < ${SHORT_TREND_MIN}，仅报明细不做趋势判定）`)
  }

  lines.push('')
  return lines.join('\n')
}

function formatLine(metric: string, value: string, extra: string, mark: string): string {
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)))
  return `  ${pad(metric, 12)} ${pad(value, 18)} ${pad(extra, 16)} ${mark}`
}

/** 近似显示宽度（中文算 2）
 *  覆盖：CJK 统一表意 + 扩展A + CJK 标点(　-〿) + 全角ASCII(！-｠) + 全角符号(￠-￦)。
 *  注意半宽片假名 ｡-ￜ 是窄字符，不纳入（故上限取 ｠），否则表格列错位。
 *  导出供报告对齐测试断言（#2）。 */
export function width(s: string): number {
  let w = 0
  for (const ch of s) {
    w += /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
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
  // R75-1：charCount 是计数维密度归一因子（可选）——旧 v1 基线缺字段须容忍：
  // 缺失/非有限/非正一律保持 undefined（= 不可归一），消费方据此降级跳过，不伪造值
  const charCount = Number(o['charCount'])
  return {
    overlongRatio,
    adjStackHits: Number(o['adjStackHits']) || 0,
    dialogueTagRatio,
    parallelStreakMax: Number(o['parallelStreakMax']) || 0,
    summaryEnding: o['summaryEnding'] === true,
    sentenceLenVariance,
    repeatRate,
    ...(Number.isFinite(charCount) && charCount > 0 ? { charCount } : {}),
    _dialogueLines: Number(o['_dialogueLines']) || 0,
  }
}
