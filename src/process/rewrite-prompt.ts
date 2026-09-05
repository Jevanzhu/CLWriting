/**
 * 改写 prompt 组装 + 续写拼稿 + 行级 diff（P1-8 架构下沉：从 studio/server/api/rewrite 下沉内核）。
 */
import { wordRange } from './draft-pipeline.js'

/** 行级 diff 结果（add/del/same） */
export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

/** 组改写 prompt(local 选段 / whole 整章，AI 自愈 + rewrite 端点共用)。
 *  A4：strategyHint 非空时作独立段注入（连续相同红项的「换策略」提醒，不拦截）。
 *  targetWords：书级 chapter_target_words（applyGlobalDefaults 合并值）——整章重写的字数
 *  区间与首稿链同口径（wordRange ±20%）；缺省回落长短篇硬编码（与首稿链一致）。此前
 *  硬编码 2000-4000/8000-20000，配了目标的书每次自愈/对话重写都被拉回默认区间。 */
export function buildRewritePrompt(
  mode: 'local' | 'whole',
  original: string,
  selection: string,
  instruction: string,
  reviewIssues: string[],
  chapter: number,
  kind: 'long' | 'short',
  strategyHint?: string,
  targetWords?: number,
): string {
  if (mode === 'local') {
    return [
      '## 原文(选中段落)',
      selection,
      '',
      '## 改写指令',
      instruction,
      '',
      '## 要求',
      '只改写选中段落,不动其他;保持正文纯文本(段落+空行,禁 MD 标题/格式)。',
    ].join('\n')
  }
  const unit = '章'
  const parts = [
    '## 任务',
    `按指令${reviewIssues.length ? ' / 审稿意见' : ''}重写第 ${chapter} ${unit}正文。`,
    '',
    `## 原${unit}正文`,
    original,
    '',
    '## 改写指令',
    instruction,
  ]
  if (reviewIssues.length) {
    parts.push('', '## 审稿意见(逐条采纳)', ...reviewIssues.map((s, i) => `${i + 1}. ${s}`))
  }
  if (strategyHint) {
    parts.push('', strategyHint)
  }
  parts.push(
    '',
    '## 要求',
    kind === 'short'
      ? `按指令重写整章正文(${wordRange('short', targetWords)},单章完整开合:铺垫→反转→收尾)。正文以 ## 标题分五段(## 开头钩子 / ## 铺垫 / ## 升级 / ## 反转 / ## 余韵,与节数机检同口径),段内纯叙事文本。`
      : `按指令重写整章正文(${wordRange('long', targetWords)},单章一主场景,章尾留钩)。`,
  )
  return parts.join('\n')
}

/** 组续写 prompt(M2 续写解选区:全文作语境,只输出续写部分,不复述原文)*/
export function buildAppendPrompt(original: string, instruction: string): string {
  return [
    '## 正文全文(语境)',
    original.trim() || '(本章尚无正文,从头开写)',
    '',
    '## 续写指令',
    instruction,
    '',
    '## 要求',
    '在正文之后继续写。只输出续写部分,不要复述或改动原文任何内容;保持正文纯文本(段落+空行,禁 MD 标题/格式),延续当前文风与情节。',
  ].join('\n')
}

/** append 续写拼稿:原文(去尾换行)+ 空行 + 续写;空白页直接用续写 */
export function appendRewritten(original: string, produced: string): string {
  const base = original.replace(/\n+$/, '')
  return base ? `${base}\n\n${produced}` : produced
}

/** R46-27（四十六轮）：DP 精确路径的两侧总行数上限——LCS 表 O(n·m)，600-800 行即
 *  数 MB 瞬态、数千行章秒级阻塞，而消费面（rewrite.ts「N 行有改动」计数 + studio 改
 *  写端点展示）在超大输入下只需量级信息。1500 = 常规章（≤20000 字 ≈ 数百行）之上、
 *  病理长文之下的分界；≤1500 走原精确路径（既有测试钉值不破）。 */
const LINE_DIFF_DP_MAX_TOTAL_LINES = 1500

/** 行级 LCS diff → DiffLine[](export 供测试)
 *  R2W-7（win 平台专项复审 R2）：行级等值剥行尾 \r——CRLF 正文（外部编辑器保存）×
 *  LF AI 产出此前逐行失配，diff 退化成整文件删+加噪块（确认 UI 不可用）。 */
export function lineDiff(a: string, b: string): DiffLine[] {
  const la = a.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  const lb = b.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  // R46-27：两侧总行数超限 → 跳过 DP 走 O(n+m) 粗计（见 coarseLineDiff 注）
  if (la.length + lb.length > LINE_DIFF_DP_MAX_TOTAL_LINES) {
    return coarseLineDiff(la, lb)
  }
  const n = la.length
  const m = lb.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const ai = la[i] ?? ''
      const bj = lb[j] ?? ''
      dp[i]![j] = ai === bj ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const ai = la[i] ?? ''
    const bj = lb[j] ?? ''
    if (ai === bj) {
      out.push({ type: 'same', text: ai })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ type: 'del', text: ai })
      i++
    } else {
      out.push({ type: 'add', text: bj })
      j++
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: la[i] ?? '' })
    i++
  }
  while (j < m) {
    out.push({ type: 'add', text: lb[j] ?? '' })
    j++
  }
  return out
}

/**
 * R46-27：大输入粗计 diff（O(n+m)）——首尾公共前缀/后缀裁剪后，中段按行多重集
 * 对称差近似：非 same 计数 = |a中段| + |b中段| − 2×Σmin(countA,countB)（消费点
 * rewrite.ts 只取 filter(type!=='same').length 作「N 行有改动」文案）。产出条目
 * 保证量的口径（same/增/删条数与粗计一致、文本真实），但删/加/同块按组聚集、
 * 不保逐行位置——LCS 对齐在此规模不可负担，展示侧只需量级。
 */
function coarseLineDiff(la: string[], lb: string[]): DiffLine[] {
  // 首部公共前缀
  let p = 0
  while (p < la.length && p < lb.length && la[p] === lb[p]) p++
  // 尾部公共后缀（不与前缀重叠）
  let s = 0
  while (s < la.length - p && s < lb.length - p && la[la.length - 1 - s] === lb[lb.length - 1 - s]) s++
  const aMid = la.slice(p, la.length - s)
  const bMid = lb.slice(p, lb.length - s)
  // 中段行多重集对称差：匹配数取 Σmin，两侧各余量为删/加
  const countsA = new Map<string, number>()
  for (const l of aMid) countsA.set(l, (countsA.get(l) ?? 0) + 1)
  const countsB = new Map<string, number>()
  for (const l of bMid) countsB.set(l, (countsB.get(l) ?? 0) + 1)
  const dels: DiffLine[] = []
  const adds: DiffLine[] = []
  const sames: DiffLine[] = []
  for (const [l, ca] of countsA) {
    const matched = Math.min(ca, countsB.get(l) ?? 0)
    for (let i = 0; i < matched; i++) sames.push({ type: 'same', text: l })
    for (let i = 0; i < ca - matched; i++) dels.push({ type: 'del', text: l })
  }
  for (const [l, cb] of countsB) {
    const matched = Math.min(countsA.get(l) ?? 0, cb)
    for (let i = 0; i < cb - matched; i++) adds.push({ type: 'add', text: l })
  }
  const out: DiffLine[] = []
  for (let i = 0; i < p; i++) out.push({ type: 'same', text: la[i]! })
  out.push(...dels, ...adds, ...sames)
  for (let i = la.length - s; i < la.length; i++) out.push({ type: 'same', text: la[i]! })
  return out
}