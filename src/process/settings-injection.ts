/**
 * 设定注入字节预算（C3 / DSH-17 三条思想，纯函数零 IO）。
 *
 * 借鉴 dsh agent-instructions 的 maxBytes 纪律：
 * - ① 预算必填强制：非正/非有限 → 直接不注入（空串），绝不静默全量；
 * - ② 超限先丢较宽泛层（project → volume → chapter），丢一层重测一次，
 *   丢到只剩最具体层仍超 → 截断该层（复用 prune.ts 头尾保留）；
 * - ③ 超限通知 in-band：被丢/被截都留声明行指名处理了什么，声明本身计入预算。
 *
 * 层序保持传入序（调用方负责项目 → 卷 → 本章排列），不按 specificity 重排。
 */
import { pruneTextMiddle, PRUNE_MARKER } from './prune.js'

/** 具体度：project(全书) 最宽泛 → chapter(本章) 最具体，宽泛者先丢 */
export type SettingsSpecificity = 'project' | 'volume' | 'chapter'

/** 设定层：调用方组装好正文（含 '## …' 标题头），本模块只管预算分配 */
export interface SettingsLayer {
  /** 层名（超限声明/调用方断言用，如 '世界观'/'角色设定'/'境界体系'） */
  name: string
  /** 具体度：越宽泛越先整层丢 */
  specificity: SettingsSpecificity
  /** 层正文（含调用方给的标题头） */
  text: string
}

/** code point 量长度（与 prune.ts 同口径，Array.from 不劈 surrogate pair） */
function cpLen(s: string): number {
  return Array.from(s).length
}

/** 被丢层的 in-band 声明行（计入预算） */
function omitLine(name: string): string {
  return `（设定超预算，已省略：${name}）`
}

/** 被截断层的 in-band 声明行（计入预算） */
function truncLine(name: string): string {
  return `（${name}超预算已截断）`
}

const SPECIFICITY_RANK: Record<SettingsSpecificity, number> = { project: 0, volume: 1, chapter: 2 }

/**
 * 组装设定注入文本：预算内全量；超限先丢宽泛层、再截断最具体层。
 *
 * - maxChars 非正/非有限 → text 空串（显式不注入），omitted/truncated 空；
 * - 总量（code point）≤ 预算 → 全量注入，omitted/truncated 空数组；
 * - 超限 → 按 project → volume → chapter（同档按传入序）逐层换成一行省略声明，
 *   每换一层重测（声明计价），达标即停；只剩最具体层仍超 → 该层 pruneTextMiddle 截断；
 * - omitted/truncated 返回层名数组（丢/截的先后序），供调用方与测试断言。
 */
export function assembleSettingsInjection(
  layers: SettingsLayer[],
  opts: { maxChars: number },
): { text: string; omitted: string[]; truncated: string[] } {
  // ① 预算守卫：非正/非有限 → 显式不注入（宁缺勿爆，不静默全量）
  if (!Number.isFinite(opts.maxChars) || opts.maxChars <= 0) {
    return { text: '', omitted: [], truncated: [] }
  }
  const maxChars = opts.maxChars

  // 预算内全量放行（层序 = 传入序）
  const full = layers.map((l) => l.text).join('\n\n')
  if (cpLen(full) <= maxChars) return { text: full, omitted: [], truncated: [] }

  // ② 逐层丢：宽泛者先丢（project → volume → chapter，同档传入序靠前者先丢）。
  // 最具体层（dropOrder 末位）不靠丢腾预算——它是压舱的最后一段。
  const dropOrder = layers
    .map((_, i) => i)
    .sort(
      (a, b) =>
        SPECIFICITY_RANK[layers[a]!.specificity] - SPECIFICITY_RANK[layers[b]!.specificity] || a - b,
    )
  const parts = layers.map((l) => l.text)
  const omitted: string[] = []
  for (let k = 0; k < dropOrder.length - 1; k++) {
    const i = dropOrder[k]!
    parts[i] = omitLine(layers[i]!.name)
    omitted.push(layers[i]!.name)
    // 每丢一层重测：省略声明行本身占预算
    if (cpLen(parts.join('\n\n')) <= maxChars) {
      return { text: parts.join('\n\n'), omitted, truncated: [] }
    }
  }

  // 丢到只剩最具体层仍超（含单层即超）→ 截断该层
  const t = dropOrder[dropOrder.length - 1]!
  const annotation = truncLine(layers[t]!.name)
  // 骨架 = 其余槽位定型（全文/省略声明）+ 本层只留标注行；余量全给正文
  const skeletonParts = [...parts]
  skeletonParts[t] = annotation
  // -1：正文与标注行之间的换行
  const bodyBudget = maxChars - cpLen(skeletonParts.join('\n\n')) - 1
  const markerLen = cpLen(PRUNE_MARKER)
  if (bodyBudget > markerLen + 2) {
    // head+tail 上限：保证 head+tail+marker 严格小于 threshold（prune 配置纪律）
    const avail = bodyBudget - markerLen - 1
    // 头重脚轻与 B3 接线口径同款（900/200 ≈ 8:2）：设定关键约束多在开头
    const head = Math.max(1, Math.floor(avail * 0.8))
    const tail = Math.max(1, avail - head)
    parts[t] = pruneTextMiddle(layers[t]!.text, { threshold: bodyBudget, head, tail }) + '\n' + annotation
  } else {
    // 预算被声明行吃光：正文置空，仅留截断声明
    parts[t] = annotation
  }
  const text = parts.join('\n\n')
  // 病态小预算：连 in-band 声明行都装不下（截断救不了声明本身的开销）
  // → 回落守卫语义显式不注入，丢/截名单照报（宁缺勿爆 + 通知不撒谎）
  if (cpLen(text) > maxChars) return { text: '', omitted, truncated: [layers[t]!.name] }
  return { text, omitted, truncated: [layers[t]!.name] }
}
