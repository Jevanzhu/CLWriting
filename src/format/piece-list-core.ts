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
 * 容错（对齐 #3 第 8 节）：缺段/缺字段不崩。
 * R65-39（第六十五轮）头注纠偏：本解析器**不**实现「未知段进 _raw」——只提取上述
 * 三段，其余未知段直接丢弃（PieceList._raw 字段从不填充）；未知段的保形由上层
 * 文本级补丁路径负责（如 config/migrate-defaults 的补丁式写回，见其「保注释保
 * 未知段」红线），本模块 stringifyPieceList 是全量重生成，经它往返不保未知段。
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

/** R26-33（二十六轮）：解析面留痕——本模块零 Node 依赖（浏览器端 MetaFormPanel 共用），
 *  不可引 log 模块（node:fs 依赖），留痕走 console.warn（双端可见、不中断解析）。 */
function warnParse(msg: string): void {
  console.warn(`[piece-list] ${msg}`)
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
    // 遇 ## 段头即结束（含同名重复段头——R26-33：原条件放行同名段头，重复段的
    // 条目会在本段解析内静默覆盖前段；终断后交给 parsePieceListBody 的
    // seenSections 判定 warn + 保留首个）
    if (/^##\s/.test(trimmed)) break

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
    // 同 parseReversalSection（R26-33：同名重复段头同样终断，防后段条目静默覆盖）
    if (/^##\s/.test(trimmed)) break

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
    // 同 parseReversalSection（R26-33：同名重复段头同样终断，防后段条目静默覆盖）
    if (/^##\s/.test(trimmed)) break

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
    // R26-33（二十六轮）：列表行两条目模式均不匹配（缺「→ 回收于 位置」/「（未回收）」
    // 标记）此前静默吞掉——作者写了回收条目却因格式偏差整条失效无迹可查。warn 留痕
    // 不中断解析（非列表行为段内说明文字，合法，仍忽略）。
    if (/^[-*]\s/.test(trimmed)) {
      warnParse(`章纲「${SECTION_PAYOFF}」行格式不符被丢弃（应为「- 伏笔 → 回收于 位置」或「- 伏笔（未回收）」）：${trimmed.slice(0, 40)}`)
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
  // R26-33（二十六轮）：重复 `## 同名段` 此前后者静默覆盖前者——作者复制粘贴出两个
  // `## 反转线索表` 时前段数据无声丢失。warn + 保留首个。与 book.yaml 重复段
  // fail-loud（R72-8）口径的差异：本解析器是浏览器共用纯函数、被表单面板直调，抛错
  // 会炸渲染；本处只留痕，段级缺失提示由 checkPieceListForm 黄项承担。
  const seenSections = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (trimmed === `## ${SECTION_REVERSAL}` || /^##\s*反转线索表/.test(trimmed)) {
      if (seenSections.has(SECTION_REVERSAL)) {
        warnParse(`章纲重复段「${SECTION_REVERSAL}」，保留首个（后段丢弃）`)
        continue
      }
      seenSections.add(SECTION_REVERSAL)
      const r = parseReversalSection(lines, i + 1)
      lead = r.lead
      i = r.endIdx - 1
    } else if (trimmed === `## ${SECTION_EMOTION}` || /^##\s*情绪曲线/.test(trimmed)) {
      if (seenSections.has(SECTION_EMOTION)) {
        warnParse(`章纲重复段「${SECTION_EMOTION}」，保留首个（后段丢弃）`)
        continue
      }
      seenSections.add(SECTION_EMOTION)
      const r = parseEmotionSection(lines, i + 1)
      emotionCurve = r.curve
      i = r.endIdx - 1
    } else if (trimmed === `## ${SECTION_PAYOFF}` || /^##\s*伏笔回收/.test(trimmed)) {
      if (seenSections.has(SECTION_PAYOFF)) {
        warnParse(`章纲重复段「${SECTION_PAYOFF}」，保留首个（后段丢弃）`)
        continue
      }
      seenSections.add(SECTION_PAYOFF)
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
    // R26-34（二十六轮）：空情绪曲线不再烘五条「待定」假数据——占位假数据会被当真
    // 曲线读回（解析端按点行收），「未填」与「已填待定」无从分辨且污染下游清单检。
    // 改对齐伏笔回收段的「（待补）」占位：非点行，解析端读回仍为空曲线（读侧不受影响）。
    lines.push('（待补）')
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