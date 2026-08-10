/**
 * 单章章纲（章纲.md）纯解析/回写 —— 零 Node 依赖，服务端与浏览器共用。
 *
 * 章纲数据存在正文（无 front matter），三段式 markdown：
 *   ## 反转线索表（- 核心反转：… / - [位置] 内容）
 *   ## 情绪曲线（- [段落] 情绪 强度/10[: 说明]）
 *   ## 伏笔回收（- 伏笔 → 回收于 位置 / - 伏笔（未回收））
 *
 * 服务端 format/manifest.ts 的文件读写（readFileSync/atomicWriteFile）依赖 node:fs，
 * 拆此 core 供浏览器端 MetaFormPanel 直接 import（对齐 words.ts re-export 先例）。
 * 容错（对齐 #3 第 8 节）：缺段/缺字段不崩，未知段进 _raw。
 */
import type { PieceList, ReversalLead, PayoffEntry, SetupPoint, EmotionCurvePoint } from './types.js'

/** 章纲.md 段标题 */
const SECTION_REVERSAL = '反转线索表'
const SECTION_EMOTION = '情绪曲线'
const SECTION_PAYOFF = '伏笔回收'

/** 默认空章纲（导入/冷启动占位，不臆造反转线索——吸收点 7.5 负向约束） */
export function emptyPieceList(): PieceList {
  return {
    反转线索表: { 核心反转: '', 铺垫点: [] },
    情绪曲线: [],
    伏笔回收: [],
  }
}

/**
 * 解析反转线索表段。
 * 格式：
 *   ## 反转线索表
 *   - 核心反转：<一句话>
 *   - 铺垫点（≥3，反转可回溯）：
 *     - [位置1] <铺垫内容>
 *     - [位置2] <铺垫内容>
 */
function parseReversalSection(lines: string[], startIdx: number): { lead: ReversalLead; endIdx: number } {
  let 核心反转 = ''
  const 铺垫点: SetupPoint[] = []
  let i = startIdx

  while (i < lines.length) {
    const trimmed = lines[i]!.trim()
    // 遇下一个 ## 段结束
    if (/^##\s/.test(trimmed) && !trimmed.includes(SECTION_REVERSAL)) break

    // 核心反转
    const coreM = trimmed.match(/^[-*]\s*核心反转[:：]\s*(.+)$/)
    if (coreM) {
      核心反转 = coreM[1]!.trim()
      i++
      continue
    }
    // 铺垫点：- [位置] 内容
    const setupM = trimmed.match(/^[-*]\s*\[([^\]]*)\]\s*(.+)$/)
    if (setupM) {
      铺垫点.push({ 位置: setupM[1]!.trim(), 内容: setupM[2]!.trim() })
      i++
      continue
    }
    i++
  }
  return { lead: { 核心反转, 铺垫点 }, endIdx: i }
}

/**
 * 解析情绪曲线段。
 * 格式：
 *   ## 情绪曲线
 *   - [开头钩子] 惊悚 3/10：尸体敲门
 *   - [反转] 震惊 9/10：来客就是死者
 */
function parseEmotionSection(lines: string[], startIdx: number): { curve: EmotionCurvePoint[]; endIdx: number } {
  const curve: EmotionCurvePoint[] = []
  let i = startIdx

  while (i < lines.length) {
    const trimmed = lines[i]!.trim()
    if (/^##\s/.test(trimmed) && !trimmed.includes(SECTION_EMOTION)) break

    const m = trimmed.match(/^[-*]\s*\[([^\]]+)\]\s*([^\s：:]+)\s+(\d+)\s*\/\s*10(?:\s*[:：]\s*(.*))?$/)
    if (m) {
      curve.push({
        段落: m[1]!.trim(),
        情绪: m[2]!.trim(),
        强度: Number(m[3]),
        ...(m[4]?.trim() ? { 说明: m[4]!.trim() } : {}),
      })
    }
    i++
  }
  return { curve, endIdx: i }
}

/**
 * 解析伏笔回收段。
 * 格式：
 *   ## 伏笔回收
 *   - <伏笔A> → 回收于 <位置>
 *   - <伏笔C>（未回收）  ← 弃坑标记
 */
function parsePayoffSection(lines: string[], startIdx: number): { entries: PayoffEntry[]; endIdx: number } {
  const entries: PayoffEntry[] = []
  let i = startIdx

  while (i < lines.length) {
    const trimmed = lines[i]!.trim()
    if (/^##\s/.test(trimmed) && !trimmed.includes(SECTION_PAYOFF)) break

    // 未回收标记：- <伏笔>（未回收）
    const unresM = trimmed.match(/^[-*]\s*(.+?)（未回收）$/)
    if (unresM) {
      entries.push({ 伏笔: unresM[1]!.trim(), 回收位置: '', 未回收: true })
      i++
      continue
    }
    // 已回收：- <伏笔> → 回收于 <位置>（兼容 → 或 -> )
    const resM = trimmed.match(/^[-*]\s*(.+?)\s*(?:→|->)\s*回收于\s*(.+)$/)
    if (resM) {
      entries.push({ 伏笔: resM[1]!.trim(), 回收位置: resM[2]!.trim() })
      i++
      continue
    }
    i++
  }
  return { entries, endIdx: i }
}

/**
 * 从章纲.md 正文解析 PieceList。
 * body 是 front matter 之后的正文（章纲.md 通常无 front matter，全文即正文）。
 */
export function parsePieceListBody(body: string): PieceList {
  const lines = body.split('\n')
  let lead: ReversalLead = { 核心反转: '', 铺垫点: [] }
  let emotionCurve: EmotionCurvePoint[] = []
  let entries: PayoffEntry[] = []

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (trimmed === `## ${SECTION_REVERSAL}` || /^##\s*反转线索表/.test(trimmed)) {
      const r = parseReversalSection(lines, i + 1)
      lead = r.lead
      i = r.endIdx - 1
    } else if (trimmed === `## ${SECTION_EMOTION}` || /^##\s*情绪曲线/.test(trimmed)) {
      const r = parseEmotionSection(lines, i + 1)
      emotionCurve = r.curve
      i = r.endIdx - 1
    } else if (trimmed === `## ${SECTION_PAYOFF}` || /^##\s*伏笔回收/.test(trimmed)) {
      const r = parsePayoffSection(lines, i + 1)
      entries = r.entries
      i = r.endIdx - 1
    }
  }
  return { 反转线索表: lead, 情绪曲线: emotionCurve, 伏笔回收: entries }
}

/** PieceList → markdown 文本（保序回写） */
export function stringifyPieceList(list: PieceList): string {
  const lines: string[] = []

  // 反转线索表
  lines.push(`## ${SECTION_REVERSAL}`)
  lines.push(`- 核心反转：${list.反转线索表.核心反转 || '（待补）'}`)
  if (list.反转线索表.铺垫点.length > 0) {
    lines.push('- 铺垫点（≥3，反转可回溯）：')
    for (const p of list.反转线索表.铺垫点) {
      lines.push(`  - [${p.位置}] ${p.内容}`)
    }
  } else {
    lines.push('- 铺垫点（≥3，反转可回溯）：（待补）')
  }
  lines.push('')

  // 情绪曲线
  lines.push(`## ${SECTION_EMOTION}`)
  if (list.情绪曲线 && list.情绪曲线.length > 0) {
    for (const p of list.情绪曲线) {
      const note = p.说明 ? `：${p.说明}` : ''
      lines.push(`- [${p.段落}] ${p.情绪} ${p.强度}/10${note}`)
    }
  } else {
    lines.push('- [开头钩子] 待定 1/10：待补')
    lines.push('- [铺垫] 待定 3/10：待补')
    lines.push('- [升级] 待定 5/10：待补')
    lines.push('- [反转] 待定 9/10：待补')
    lines.push('- [余韵] 待定 6/10：待补')
  }
  lines.push('')

  // 伏笔回收
  lines.push(`## ${SECTION_PAYOFF}`)
  if (list.伏笔回收.length === 0) {
    lines.push('（待补）')
  } else {
    for (const e of list.伏笔回收) {
      if (e.未回收) {
        lines.push(`- ${e.伏笔}（未回收）`)
      } else {
        lines.push(`- ${e.伏笔} → 回收于 ${e.回收位置}`)
      }
    }
  }

  return lines.join('\n')
}