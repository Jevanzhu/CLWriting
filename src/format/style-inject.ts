/**
 * 条目库 → 注入材料（文风系统重整 S5 预算分配）。
 *
 * 性价比排序（计划 §注入=预算分配）：
 *   禁词  压成一行「禁用：A、B、C」——几十字，必带
 *   手法  每条一句话——最省，优先塞满
 *   反例  关键 1–2 条（带说明）
 *   样章  50–500 字最贵——单独成弹性段，预算兜底（prepare 大闸降档）
 *
 * 铁律瘦身后的纯配置（阈值/删除分级）不注入——AI 不需要知道阈值数字。
 * 场景过滤：场景 ∈ 本章场景 ∪「通用」才候选；排序=场景命中序 → 证据强度。
 */

import { SOURCE_RANK, bannedEntryWords } from './style-entry.js'
import type { StyleEntry } from './types.js'

/** 注入样章单条最长字数（超出截断，与「样章 50–500 字」上限一致） */
export const SAMPLE_INJECT_MAX = 500

/** 反例注入条数上限（计划：关键 1–2 条） */
export const CONTRA_INJECT_MAX = 2

/** 场景命中序：主场景 0 < 次场景 1 < … < 通用；场景不相关 → -1（不候选） */
function sceneRank(e: StyleEntry, scenes: string[]): number {
  if (e.场景 === '通用') return scenes.length
  const i = scenes.indexOf(e.场景)
  return i
}

/** 过滤 + 排序：场景命中序 → 证据强度（改稿行为最强）→ 路径稳定序 */
function pickSorted(entries: StyleEntry[], kind: StyleEntry['类型'], scenes: string[]): StyleEntry[] {
  return entries
    .filter((e) => e.类型 === kind && sceneRank(e, scenes) !== -1)
    .sort((a, b) => {
      const sr = sceneRank(a, scenes) - sceneRank(b, scenes)
      if (sr !== 0) return sr
      const ev = SOURCE_RANK[a.来源] - SOURCE_RANK[b.来源]
      if (ev !== 0) return ev
      return (a._path ?? '').localeCompare(b._path ?? '')
    })
}

/**
 * 便宜段（必带）：禁词一行 + 手法逐条 + 反例 1–2 条。
 * 无相关条目 → ''（调用方跳段）。
 */
export function buildStyleEssentials(entries: StyleEntry[], scenes: string[]): string {
  const parts: string[] = []

  const banned = pickSorted(entries, '禁词', scenes)
  // R30-15（三十轮）：禁词注入改用与机检 readBannedEntryWords 同源的取词口径
  //（style-entry.bannedEntryWords 逐行拆词）——原把条目正文整段（可含多行说明文本）
  // 直接 join 注入，与机检拆词口径分裂，说明性条目把整段原文塞进 prompt 白烧预算。
  // 现只注入解析出的词；整条解析不出词的条目不注入（机检侧对同一形态已产
  // unparsed 黄项提示，不静默失明）。
  if (banned.length > 0) {
    const words = banned.flatMap((e) => bannedEntryWords(e.正文))
    if (words.length > 0) {
      parts.push(`禁用：${words.join('、')}`)
    }
  }

  const moves = pickSorted(entries, '手法', scenes)
  if (moves.length > 0) {
    parts.push(['写法要点：', ...moves.map((e) => `- ${e.正文}`)].join('\n'))
  }

  const contras = pickSorted(entries, '反例', scenes).slice(0, CONTRA_INJECT_MAX)
  if (contras.length > 0) {
    const blocks = contras.map((e) => (e.说明 ? `${e.正文}\n——${e.说明}` : e.正文))
    parts.push(['反面例（避免这样写）：', ...blocks].join('\n'))
  }

  return parts.join('\n\n')
}

/**
 * 样章挑选（G2 跨场景语义保持）：第一轮每场景各取最强 1 条保代表性，
 * 第二轮按场景序补满 maxCount；通用垫底兜底。
 */
export function pickSampleEntries(
  entries: StyleEntry[],
  scenes: string[],
  maxCount: number,
): StyleEntry[] {
  const sorted = pickSorted(entries, '样章', scenes)
  // 按场景命中序分组（保持组内强度序）
  const groups = new Map<number, StyleEntry[]>()
  for (const e of sorted) {
    const r = sceneRank(e, scenes)
    const g = groups.get(r) ?? []
    g.push(e)
    groups.set(r, g)
  }
  const ranks = [...groups.keys()].sort((a, b) => a - b)
  const picked: StyleEntry[] = []
  for (const r of ranks) {
    if (picked.length >= maxCount) break
    picked.push(groups.get(r)![0]!)
  }
  for (const r of ranks) {
    for (const e of groups.get(r)!.slice(1)) {
      if (picked.length >= maxCount) return picked
      picked.push(e)
    }
  }
  return picked
}

/** 样章条目 → 注入文本：说明作技法指令行（对齐旧样章格式），超长截断。
 *  R72-7（二十轮 C-2）：截断按码位（Array.from 迭代码点，对齐全库 code point 口径）——
 *  UTF-16 码元 slice 会把增补平面字符切成半个代理对。 */
export function sampleEntryText(e: StyleEntry): string {
  const body =
    e.正文.length > SAMPLE_INJECT_MAX
      ? `${Array.from(e.正文).slice(0, SAMPLE_INJECT_MAX).join('')}……`
      : e.正文
  return e.说明 ? `技法指令：${e.说明}\n${body}` : body
}
