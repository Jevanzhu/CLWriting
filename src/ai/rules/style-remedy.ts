/**
 * 风格修复指令翻译层（B1：指纹→证据→指令）。
 *
 * 纯正则/统计提取，零 AI 调用。
 * 从正文提取具体证据（重复词组 / 超长句原文 / 总结句原文），
 * 生成带证据的修复建议，替代 style-rule.ts 原有的静态建议。
 */

import { splitSentences } from '../../format/sentences.js'
import { clipByCodePoints, codePointLength } from '../../process/summary.js'

/** 总结体开头词 */
const SUMMARY_KEYWORDS = ['总之', '综上', '总而言之', '由此可见', '这一切', '如此看来', '说到底']

/** 超长句默认阈值（字数），与 check.ts 的 fallback 口径一致 */
const DEFAULT_MAX_SENTENCE_LEN = 40

/** 超长句证据截断长度 */
const LONG_SENTENCE_TRUNCATE = 30

/** 总结句证据截断长度 */
const SUMMARY_TRUNCATE = 40

/**
 * 从正文提取重复出现的 2-4 字中文词组（出现 ≥2 次，top 5）。
 *
 * 滑窗提取连续中文片段的所有 2-4 字子串，统计频次，
 * 去除被更长高频词组包含的短词组（避免「他走」「走进」被「他走进」覆盖），返回 top 5。
 */
export function extractRepeatPhrases(body: string): string[] {
  const counts = new Map<string, number>()
  // 找所有连续中文片段（≥2 字）
  const runs = body.match(/[一-鿿㐀-䶿]{2,}/g)
  if (!runs) return []
  for (const run of runs) {
    for (let size = 2; size <= 4; size++) {
      for (let i = 0; i <= run.length - size; i++) {
        const sub = run.slice(i, i + size)
        counts.set(sub, (counts.get(sub) ?? 0) + 1)
      }
    }
  }
  // 过滤 ≥2 次，按频次降序、长度降序排列（优先更长更有意义的词组）
  const sorted = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
  // 去除被已选更长词组包含的短词组
  const result: string[] = []
  for (const [phrase] of sorted) {
    if (result.some((r) => r.includes(phrase) && r !== phrase)) continue
    result.push(phrase)
    if (result.length >= 5) break
  }
  return result
}

/**
 * 从正文提取超长句子（按 。！？分割，超 maxLen 的取最长 3 个，截断到 30 字 + ……）。
 * maxLen 默认 40（如 IronRules 有 maxSentenceLen 可由调用方传入）。
 */
export function extractLongSentences(body: string, maxLen = DEFAULT_MAX_SENTENCE_LEN): string[] {
  // R41-4（四十一轮）：长度与截断改码位口径（clipByCodePoints/codePointLength）——
  // 原 UTF-16 .length/.slice 在增补平面字符（emoji 等 4 字节码点）边界会把代理对
  // 劈成孤立 U+FFFD（与 summary 裁剪 R64-6/R72-7 同族，本处漏网）
  const overlong = splitSentences(body)
    .filter((s) => codePointLength(s) > maxLen)
  // 按长度降序取前 3
  const top3 = overlong.sort((a, b) => codePointLength(b) - codePointLength(a)).slice(0, 3)
  // 截断到 30 字 + ……
  return top3.map((s) => (codePointLength(s) > LONG_SENTENCE_TRUNCATE ? `${clipByCodePoints(s, LONG_SENTENCE_TRUNCATE)}……` : s))
}

/**
 * 从正文末段提取总结句（匹配总结词：总之/综上/总而言之/由此可见/这一切/如此看来/说到底）。
 * 扫最后 2 段，匹配总结词开头的句子，返回该句（截断到 40 字）。无命中 → null。
 */
export function extractSummaryEnding(body: string): string | null {
  // 按空行分段，取最后 2 段
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const tail = paragraphs.slice(-2).join('\n')
  // 统一分句口径（P2-BE-6）
  const sentences = splitSentences(tail)
  for (const s of sentences) {
    if (SUMMARY_KEYWORDS.some((kw) => s.startsWith(kw))) {
      // R41-4：同上码位口径
      return codePointLength(s) > SUMMARY_TRUNCATE ? `${clipByCodePoints(s, SUMMARY_TRUNCATE)}……` : s
    }
  }
  return null
}

/**
 * 生成带证据的风格修复建议（仅建议部分，不含偏离前缀）。
 *
 * 根据维度名分派：
 * - 复读率 → 重复词组证据（extractRepeatPhrases）
 * - 结尾总结体 → 总结句原文（extractSummaryEnding）
 * - 句长方差 → 方向化建议（偏低拆短句 / 偏高加交替）
 * - 单句超限占比 → 超长句原文（extractLongSentences）
 * - 其他（形容词堆叠 / 排比连续度 / 对话标签占比）→ 静态建议（取 advice 参数）
 */
export function styleRemedy(
  dimName: string,
  current: number,
  ref: number,
  body: string,
  advice = '',
): string {
  switch (dimName) {
    case '复读率': {
      const phrases = extractRepeatPhrases(body)
      return phrases.length > 0
        ? `以下词组重复出现：${phrases.join('、')}，各保留一次`
        : '降低句式重复'
    }
    case '结尾总结体': {
      const sentence = extractSummaryEnding(body)
      return sentence !== null
        ? `删去段末总结句：「${sentence}」，让场景直接切出`
        : '检查结尾是否有总结性语句'
    }
    case '句长方差':
      // 偏低 → 句式太均（需要拆长句加短句）；偏高 → 句式太散（需要交替）
      return current < ref
        ? '把长句拆开，段落里混入三五字的短句'
        : '增加长短句交替，避免句式过于跳跃'
    case '单句超限占比': {
      const longSents = extractLongSentences(body)
      return longSents.length > 0
        ? `以下句子过长建议拆分：${longSents.join('、')}`
        : '建议拆分长句、控制单句长度'
    }
    default:
      return advice || '建议调整'
  }
}
