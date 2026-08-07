/**
 * 短篇反转类型分类 —— 纯函数，零 Node 依赖（服务端 / 浏览器共用）。
 *
 * 单一真相源：metrics 离线报告（short-index.ts）与 rhythm 总览缺口（rhythm.ts）
 * 共用本模块，避免「同一个核心反转，两处分类不一致」。
 *
 * 类型集（对齐 metrics 层宽分类，兜底「其他反转」）：
 *   死者反转 / 真凶反转 / 自我反转 / 亲密关系反转 / 身份反转 /
 *   时间/记忆反转 / 现实层反转 / 其他反转
 *
 * 匹配策略：
 *   1. normalize 去空白标点后匹配（对齐 metrics 层）
 *   2. 「不是…而是」强信号：后半句含真凶/身份词优先特判（fixture「中奖者设局」归真凶）
 *   3. 顺序敏感，首个命中即归类
 *   4. 无命中 → 「其他反转」兜底（metrics 语义：真实类型，非未识别）
 */
import type { ReversalLead } from './types.js'

/** 内置反转类型全集（顺序即匹配优先级） */
const REVERSAL_TYPES = [
  '死者反转',
  '真凶反转',
  '身份反转',
  '时间/记忆反转',
  '现实层反转',
  '亲密关系反转',
  '自我反转',
  '其他反转',
] as const
export type ReversalTypeName = (typeof REVERSAL_TYPES)[number]

/** 各类型触发正则（pre-normalization 后 test） */
const REVERSAL_PATTERNS: Record<Exclude<ReversalTypeName, '其他反转'>, RegExp> = {
  死者反转: /死|亡|尸|骨|坟|墓|墓碑|鬼|幽灵|遗言|生前/,
  真凶反转: /凶手|真凶|杀手|犯人|设局|幕后|主谋|嫌疑|栽赃|顶罪|真相/,
  身份反转: /身份|卧底|替身|冒名|伪装|假扮|冒充|真实身份|血缘|亲生/,
  '时间/记忆反转': /时间|循环|未来|过去|记忆|重试|失忆|前世/,
  现实层反转: /梦|幻觉|剧本|游戏|实验|虚拟|醒来|舞台/,
  亲密关系反转: /亲人|父亲|母亲|哥哥|姐姐|弟弟|妹妹|妻子|丈夫|恋人/,
  自我反转: /自己|本人|主角|我/,
}

/** 「不是…而是」强信号（normalize 后匹配；B-P2-4：放宽为任意 1+ 字符间隔） */
const COUNTER_SIGNAL = /不是.{1,}?而是/
/** 强信号后半句的真凶 / 身份特征词 */
const MURDER_WORDS = ['凶手', '真凶', '设局', '幕后', '主谋', '嫌疑', '栽赃', '顶罪', '真相', '杀手', '犯人']
const IDENTITY_WORDS = ['真实身份', '替身', '冒充', '伪装', '假扮', '身份', '亲生', '血缘', '卧底', '冒名']

/** normalize：去空白 + 常见标点（对齐 metrics 层 short-index.ts normalize） */
function normalize(value: string): string {
  return value.replace(/\s+/g, '').replace(/[，。！？、；：:「」"'（）()]/g, '').trim()
}

/**
 * 把自由文本核心反转归类到内置类型。
 * @returns 命中类型名；无命中返回「其他反转」（metrics 语义，非 null）。
 */
export function classifyReversal(text: string): ReversalTypeName {
  const t = normalize(text)
  if (!t) return '其他反转'

  // 强信号：不是…而是（真凶 / 身份），后半句命中对应词才特判
  const m = t.match(COUNTER_SIGNAL)
  if (m) {
    const secondHalf = t.slice(m.index! + m[0].length)
    if (MURDER_WORDS.some((w) => secondHalf.includes(w))) return '真凶反转'
    if (IDENTITY_WORDS.some((w) => secondHalf.includes(w))) return '身份反转'
    // 后半句无特征词 → 不是反转信号（如「不是遗物而是告别」），落普通匹配
  }

  // 顺序敏感：首个命中即归类（README 样例 + fixture 实测）
  for (const type of REVERSAL_TYPES) {
    if (type === '其他反转') continue
    if (REVERSAL_PATTERNS[type].test(t)) return type
  }
  return '其他反转'
}

/** 从清单反转线索表提取文本（供上层分类；缺核心反转返回空串） */
export function reversalText(lead: ReversalLead): string {
  return lead.核心反转?.trim() ?? ''
}