/**
 * 文风比对层（文风系统重整 S3）：AI 版 vs 作者版的纯函数比对，零落盘。
 *
 * 词级——AI 版有、作者版无的 n-gram（禁词候选原料；跨章频次聚合在候选箱 S4 做）。
 * 段级——n-gram Jaccard 相似度分层：
 *   >95% 已对齐（aligned，不产候选）
 *   70–95% 表层微调（surface，供词级信号）
 *   <70% 文风缺口（gap，作者版 → 样章候选）
 *
 * 不引 diff 库：与项目零依赖风格一致（git 走 spawnSync 同理）。
 */

/** 按非汉字切分 → 纯汉字片段流（跨标点/空白的 n-gram 无意义，先切干净） */
function hanRuns(text: string): string[] {
  return text.match(/\p{Script=Han}+/gu) ?? []
}

/** 字符 n-gram 集合；片段短于 n 时以片段全体入集（「好」vs「坏」不因空集误判相同） */
export function charNgrams(text: string, n: number): Set<string> {
  const grams = new Set<string>()
  for (const run of hanRuns(text)) {
    if (run.length < n) {
      grams.add(run)
      continue
    }
    for (let i = 0; i + n <= run.length; i++) grams.add(run.slice(i, i + n))
  }
  return grams
}

/**
 * 词级信号：AI 版有、作者版无的 n-gram（n=5..2 降序扫，极大化去碎片——
 * 「深吸一口气」整体缺失时不再报「深吸」「一口气」等子串）。
 */
export function missingNgrams(aiText: string, authorText: string): string[] {
  const out: string[] = []
  for (let n = 5; n >= 2; n--) {
    const authorGrams = charNgrams(authorText, n)
    for (const gram of charNgrams(aiText, n)) {
      if (gram.length !== n) continue // 短 run 兜底项不作候选
      if (authorGrams.has(gram)) continue
      if (out.some((s) => s.includes(gram))) continue // 已被更长缺失项覆盖
      out.push(gram)
    }
  }
  return out
}

/** n-gram Jaccard 相似度（默认 bigram）；两侧皆空视为相同 → 1 */
export function similarity(a: string, b: string, n = 2): number {
  const ga = charNgrams(a, n)
  const gb = charNgrams(b, n)
  if (ga.size === 0 && gb.size === 0) return 1
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}

/** 段级分层：>95% 已对齐 / 70–95% 表层微调 / <70% 文风缺口 */
export type SimTier = 'aligned' | 'surface' | 'gap'
export function tierOf(sim: number): SimTier {
  if (sim > 0.95) return 'aligned'
  if (sim >= 0.7) return 'surface'
  return 'gap'
}

/** 按空行拆段（与正文段落惯例一致），去空 */
function splitParas(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
}

export interface ParaCompare {
  authorPara: string
  aiPara: string | null // null = AI 版无对应段（作者新增，视作缺口）
  sim: number
  tier: SimTier
}

export interface CompareResult {
  overallSim: number
  paras: ParaCompare[]
  missing: string[] // 词级信号（禁词候选原料），只取 surface 段——gap 段全重写，词级差全量无信号
}

/**
 * 整章比对：段落全局贪心配对（相似度降序，一一配对）；
 * 配不上的作者段 sim=0 → gap（大改/新写正是样章候选信号）。
 */
export function compareVersions(aiText: string, authorText: string): CompareResult {
  const aiParas = splitParas(aiText)
  const auParas = splitParas(authorText)

  // 所有 (作者段, AI段) 对按相似度降序全局贪心
  const pairs: { ai: number; au: number; sim: number }[] = []
  for (let au = 0; au < auParas.length; au++) {
    for (let ai = 0; ai < aiParas.length; ai++) {
      pairs.push({ ai, au, sim: similarity(aiParas[ai]!, auParas[au]!) })
    }
  }
  pairs.sort((x, y) => y.sim - x.sim)

  const aiUsed = new Set<number>()
  const auMatch = new Map<number, { ai: number; sim: number }>()
  for (const p of pairs) {
    if (aiUsed.has(p.ai) || auMatch.has(p.au)) continue
    aiUsed.add(p.ai)
    auMatch.set(p.au, { ai: p.ai, sim: p.sim })
  }

  const paras: ParaCompare[] = auParas.map((para, au) => {
    const m = auMatch.get(au)
    const sim = m?.sim ?? 0
    return { authorPara: para, aiPara: m ? aiParas[m.ai]! : null, sim, tier: tierOf(sim) }
  })

  // 词级信号：surface 配对段逐对取缺失 n-gram（对内已极大化，跨对 Set 去重）
  const missing = new Set<string>()
  for (const p of paras) {
    if (p.tier !== 'surface' || !p.aiPara) continue
    for (const g of missingNgrams(p.aiPara, p.authorPara)) missing.add(g)
  }

  return { overallSim: similarity(aiText, authorText), paras, missing: [...missing] }
}
