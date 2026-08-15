/**
 * 备料 + 输入预算闸 —— 阶段 3（母本第 6.3 节，依据 #12 输入预算闸 spec）。
 *
 * 组装写稿材料：近况 + 本章账本推进条目 + 设定边界 + 文风（条目库/铁律）+ 文风样章 + 近章结尾 + 前章正文结尾。
 *
 * 预算闸（#12）：
 * 1. 源头限流——账本只取本章细纲声明推进的条目 + 少数悬太久（不取全部 open）
 * 2. 兜底裁剪——超预算按弹性优先级 #4→#3→#2→#1 先降档（减量保留）、仍超再整段移除，刚需绝不砍
 * 3. 软预算——不硬拒，裁剪 + 头部留痕
 */

import type { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseChapterFileName } from '../format/words.js'
import { assembleStatus, formatStatus } from './assemble.js'
import { readLeadHistory, readChapterSummaries } from '../format/read.js'
import { readFile } from '../format/frontmatter.js'
import { readSamplesByScene } from '../format/style.js'
import { readEntries, ENTRIES_DIR } from '../format/style-entry.js'
import { buildStyleEssentials, pickSampleEntries, sampleEntryText } from '../format/style-inject.js'
import type { BookConfig, StyleSample } from '../format/types.js'
import { readForeshadows, scanForeshadowTrails } from '../document/foreshadow.js'
import { isWithinRoot } from '../fs/safe-path.js'

/**
 * W-P2-4：按章号在 写作/正文/ 找正文文件，只扫「根目录 + 直接卷子目录」两层，
 * 替代 readChapterDir 全树递归扫描（备料为取一章此前要 stat/读全书所有 md）。
 * 文件名契约 `<数字>-<标题>.md`（parseChapterFileName），可补零。找不到 → null。
 * 正确性兜底：卷目录只存在一层（写作/正文/<卷>/），更深嵌套不在此结构内——
 * 若未来出现更深嵌套，此处返回 null 由调用方降级（不产出该段，行为与「无此章」一致）。
 */
function findChapterByNumber(bookRoot: string, chapterNo: number): string | null {
  const bodyRoot = join(bookRoot, '写作', '正文')
  const tryFile = (dir: string): string | null => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return null
    }
    for (const name of entries) {
      if (!name.endsWith('.md') || name.startsWith('._')) continue
      const parsed = parseChapterFileName(name)
      if (parsed && parsed.章号 === chapterNo) return join(dir, name)
    }
    return null
  }

  // ① 正文根目录散章
  const atRoot = tryFile(bodyRoot)
  if (atRoot) return atRoot

  // ② 各卷子目录（写作/正文/<卷>/）
  let volDirs: string[]
  try {
    volDirs = readdirSync(bodyRoot).filter((n) => {
      try { return statSync(join(bodyRoot, n)).isDirectory() } catch { return false }
    })
  } catch {
    return null
  }
  for (const v of volDirs) {
    const inVol = tryFile(join(bodyRoot, v))
    if (inVol) return inVol
  }
  return null
}

/** 写作材料的各段（按裁剪优先级标注刚需/弹性） */
export interface MaterialSection {
  /** 段标题 */
  title: string
  /** 段内容 */
  content: string
  /** 刚需（永不裁剪）还是弹性（可降档/裁剪） */
  essential: boolean
  /** 弹性优先级（#12 第 4 节，数字越大越先砍：5=RAG召回, 4=非本章预警, 3=远期摘要, 2=文风样章, 1.5=前章正文结尾, 1=近章结尾摘要） */
  flexibleRank?: number
  /** 降档版内容（减量保留，#12 第 4 节"按序降档"）；裁剪时先降档、仍超再整段移除 */
  degradedContent?: string
}

/** 备料结果 */
export interface PrepareResult {
  /** 组装的全部段 */
  sections: MaterialSection[]
  /** 合并后的写作材料文本（含留痕） */
  text: string
  /** token 估算总量 */
  estimatedTokens: number
  /** 是否发生了裁剪 */
  trimmed: boolean
  /** 裁剪记录（供留痕） */
  trimLog: string[]
}

/** token 粗估（#12 第 5 节：中文约 0.6 token/字） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.6)
}

/**
 * 取正文末尾至多 maxChars 字，按段落边界（`\n\n`）截断，不切半句。
 * C1 前章正文结尾段用——1500 字全量 / 500 字降档。
 */
function tailByParagraph(body: string, maxChars: number): string {
  const trimmed = body.trimEnd()
  if (trimmed.length <= maxChars) return trimmed
  const tail = trimmed.slice(-maxChars)
  // 跳到首个段落边界之后，避免切半句；无边界则原样返回（极长段罕见）
  const boundary = tail.indexOf('\n\n')
  return boundary === -1 ? tail : tail.slice(boundary + 2)
}

/**
 * 备料组装 + 预算闸。
 *
 * @param db 缓存
 * @param config book.yaml
 * @param bookRoot 书仓库根
 * @param chapterLeadIds 本章细纲声明推进的账本条目 id（#12 第 2 节#2 源头限流）
 * @param ragRecallText 可选：RAG 召回的正文片段文本（#37 R1 接缝）。
 *        调用方在 prepare 外异步 await 召回后传入；非空则 push 为弹性段（flexibleRank 5，最先砍）。
 *        **不传 → 无此段 → 行为与现状逐字节一致**（工单验收红线）。
 * @param sampleScene 文风样章场景。可单值或多值（G2 跨场景）；缺省回落「战斗」，保持旧调用兼容。
 */
export function prepare(
  db: DatabaseSync,
  config: BookConfig,
  bookRoot: string,
  chapterLeadIds: string[],
  ragRecallText?: string,
  sampleScene: string | string[] = '战斗',
): PrepareResult {
  // 编排层：各段组装 → 预算裁剪 → 序列化（子函数见下）
  const snapshot = assembleStatus(db, config, config.book.volume_size ?? 50)
  const scenes = Array.isArray(sampleScene) ? sampleScene : [sampleScene]

  const sections: MaterialSection[] = [
    ...buildStatusSection(snapshot),
    ...buildLedgerSection(db, chapterLeadIds),
    ...buildStyleSections(bookRoot, config, scenes),
    ...buildEndingsSections(db, bookRoot, snapshot),
    ...buildOutlookSections(bookRoot, snapshot, chapterLeadIds, ragRecallText),
  ]

  const trimLog: string[] = []
  const { estimatedTokens, trimmed } = applyBudgetTrim(config, sections, trimLog)
  const text = serializeSections(sections, trimmed, trimLog)

  return {
    sections,
    text,
    estimatedTokens,
    trimmed,
    trimLog,
  }
}

/** 弹性#1 近章结尾 + 弹性#1.5 前章正文结尾（最靠后砍，保留连贯性） */
function buildEndingsSections(
  db: DatabaseSync,
  bookRoot: string,
  snapshot: ReturnType<typeof assembleStatus>,
): MaterialSection[] {
  const sections: MaterialSection[] = []

  // 弹性#1 近章结尾（缩 1-2 章，flexibleRank=1，最后才砍；降档=只留最近 1 章）
  const recentEndings = readChapterSummaries(db, Math.max(1, snapshot.currentChapter - 1), snapshot.currentChapter)
  if (recentEndings.length > 0) {
    const parts: string[] = []
    for (const r of recentEndings) {
      if (existsSync(r.path) && isWithinRoot(bookRoot, r.path)) {
        parts.push(`【第${r.ref}章结尾】\n${readFileSync(r.path, 'utf-8').trim()}`)
      }
    }
    if (parts.length > 0) {
      sections.push({
        title: '近章结尾',
        content: parts.join('\n\n'),
        essential: false,
        flexibleRank: 1,
        degradedContent: parts.slice(-1).join('\n\n'),
      })
    }
  }

  // 弹性#1.5 前章正文结尾（C1：衔接靠原文不靠转述；摘要丢结尾场景实际文字 + 行文即时语感）
  // 来源：readChapterDir 递归扫描 写作/正文/（含 untracked 草稿）；都无则无此段（第 1 章/缺文件 → 行为逐字节不变）
  // flexibleRank=1.5：比近章结尾摘要（rank 1）先砍、比文风样章（rank 2）后砍；降档=末尾 500 字
  const prevChapterNo = snapshot.currentChapter - 1
  if (prevChapterNo >= 1) {
    let prevBody: string | null = null
    // W-P2-4：只扫 正文根+卷目录 两层找前一章，不再全树 readChapterDir（为取一章读全书）
    const prevPath = findChapterByNumber(bookRoot, prevChapterNo)
    if (prevPath && isWithinRoot(bookRoot, prevPath)) {
      const r = readFile(prevPath)
      if (r.ok) prevBody = r.body
    }
    if (prevBody !== null) {
      const full = tailByParagraph(prevBody, 1500)
      if (full.length > 0) {
        sections.push({
          title: '前章正文结尾',
          content: `【第${prevChapterNo}章正文结尾】\n${full}`,
          essential: false,
          flexibleRank: 1.5,
          degradedContent: `【第${prevChapterNo}章正文结尾】\n${tailByParagraph(prevBody, 500)}`,
        })
      }
    }
  }

  return sections
}

/** #3 文风（刚需）+ 弹性#2 文风样章 + 弹性#2b 伏笔提醒 */
function buildStyleSections(
  bookRoot: string,
  config: BookConfig,
  scenes: string[],
): MaterialSection[] {
  const sections: MaterialSection[] = []

  // 文风（S5 预算分配）：条目库存在 → 禁词/手法/反例便宜段必带，铁律纯配置不注入；
  // 未迁移书（无条目库）→ 旧行为：铁律全文刚需注入
  const entriesDir = join(bookRoot, ENTRIES_DIR)
  const hasEntryLib = existsSync(entriesDir)
  const entryLib = hasEntryLib ? readEntries(entriesDir).entries : []
  if (hasEntryLib) {
    const ess = buildStyleEssentials(entryLib, scenes)
    if (ess) {
      sections.push({ title: '文风', content: ess, essential: true })
    }
  } else {
    const ironPath = join(bookRoot, '文风', '文风铁律.md')
    if (existsSync(ironPath)) {
      sections.push({
        title: '文风铁律',
        content: readFileSync(ironPath, 'utf-8').trim(),
        essential: true,
      })
    }
  }

  // 弹性#2 文风样章（降浓度，flexibleRank=2；降档=只留 1 段）
  // 条目库路（S5）：pickSampleEntries 保持 G2 跨场景语义（每场景 1 条保代表 + 主场景补满）；
  // 未迁移书走旧样章库。总量受注入档约束（轻 1 段 / 重 3 段，母本第 1.4 节）
  const maxTotal = config.style.injection === 'heavy' ? 3 : 1
  let sampleParts: string[] = []
  if (hasEntryLib) {
    sampleParts = pickSampleEntries(entryLib, scenes, maxTotal).map(sampleEntryText)
  } else {
    const sampleDir = join(bookRoot, '文风', '样章库')
    const perScene = scenes.map((sc) => readSamplesByScene(sampleDir, sc).samples)
    // 第一轮：每场景各取 1（保证次场景有代表）；第二轮：主场景补满到 maxTotal
    const picked: StyleSample[] = []
    for (const samples of perScene) {
      if (samples.length > 0) picked.push(samples[0]!)
    }
    for (let i = 1; picked.length < maxTotal && i < (perScene[0]?.length ?? 0); i++) {
      picked.push(perScene[0]![i]!)
    }
    sampleParts = picked.slice(0, maxTotal).map((s) => {
      if (!s.技法指令) return s.正文
      return `技法指令：${s.技法指令}\n${s.正文}`
    })
  }
  if (sampleParts.length > 0) {
    sections.push({
      title: '文风样章',
      content: sampleParts.join('\n\n'),
      essential: false,
      flexibleRank: 2,
      degradedContent: sampleParts.slice(0, 1).join('\n\n'),
    })
  }

  // 弹性#2b 伏笔提醒（足迹扫描驱动，flexibleRank=2）
  // 未回收 + 高风险（红/黄）的伏笔——写作时提醒 AI 别忘记回收（替代账本 staleLeads 伏笔部分）
  const fsEntries = readForeshadows(bookRoot)
  if (fsEntries.length > 0) {
    const fsTrails = scanForeshadowTrails(bookRoot, fsEntries)
    const staleFs = fsEntries
      .filter((f) => f.状态 === '未回收')
      .flatMap((f) => {
        const t = fsTrails.get(f.标题)
        return t && (t.risk === '红' || t.risk === '黄') ? [{ f, t }] : []
      })
    if (staleFs.length > 0) {
      const fsLines = staleFs.map(({ f, t }) => {
        const kws = f.关联词.length > 0 ? f.关联词.slice(0, 3).join('/') : f.标题
        const last = t.lastHit !== null ? `，末次提及 ch.${t.lastHit}` : ''
        return `[${f.重要性}] ${f.标题}（${kws}）悬置 ${t.staleSpan} 章${last}`
      })
      sections.push({
        title: '伏笔提醒（高风险未回收）',
        content: fsLines.join('\n'),
        essential: false,
        flexibleRank: 2,
        degradedContent: staleFs.map(({ f }) => `[${f.重要性}] ${f.标题}`).join('\n'),
      })
    }
  }

  return sections
}

/** #1 近况（刚需——AI 必须知道写到哪里了） */
function buildStatusSection(snapshot: ReturnType<typeof assembleStatus>): MaterialSection[] {
  return [{
    title: '近况',
    content: formatStatus(snapshot),
    essential: true,
  }]
}

/** #2 本章账本推进条目（刚需——#12 第 2 节#2 源头限流：只取本章涉及的） */
function buildLedgerSection(db: DatabaseSync, chapterLeadIds: string[]): MaterialSection[] {
  if (chapterLeadIds.length === 0) return []
  const parts: string[] = []
  for (const id of chapterLeadIds) {
    const history = readLeadHistory(db, id)
    parts.push(`【${id}】`)
    for (const h of history.slice(-3)) {
      // 只取最近 3 条履历（源头限流）
      parts.push(`  第${h.章号}章 ${h.动词}：${h.证据}`)
    }
  }
  return [{
    title: '本章推进的账本',
    content: parts.join('\n'),
    essential: true,
  }]
}

/** 弹性#3 远期卷摘要 + 弹性#4 非本章预警 + #8 RAG 召回（flexibleRank 3/4/5） */
function buildOutlookSections(
  bookRoot: string,
  snapshot: ReturnType<typeof assembleStatus>,
  chapterLeadIds: string[],
  ragRecallText?: string,
): MaterialSection[] {
  const sections: MaterialSection[] = []

  // 弹性#3 远期卷摘要（降粗档，flexibleRank=3）
  if (snapshot.currentVolume > 1) {
    const volSummaryPath = join(bookRoot, '定稿', '摘要', '卷摘要', `${snapshot.currentVolume - 1}.md`)
    if (existsSync(volSummaryPath)) {
      sections.push({
        title: `第${snapshot.currentVolume - 1}卷摘要`,
        content: readFileSync(volSummaryPath, 'utf-8').trim(),
        essential: false,
        flexibleRank: 3,
      })
    }
  }

  // 弹性#4 非本章悬太久预警（只列编号，flexibleRank=4，最先砍）
  const otherStale = snapshot.staleLeads.filter((s) => !chapterLeadIds.includes(s.id))
  if (otherStale.length > 0) {
    sections.push({
      title: '其他悬太久的线（仅编号）',
      content: otherStale.map((s) => `${s.id}（${s.type}）悬${s.age}章`).join('\n'),
      essential: false,
      flexibleRank: 4,
    })
  }

  // #8 RAG 召回（弹性，flexibleRank 5 最先砍，#37 R1 接缝）
  // 不传/空串 → 无此段 → prepare 行为逐字节不变（验收红线）
  if (ragRecallText && ragRecallText.length > 0) {
    sections.push({
      title: 'RAG 召回',
      content: ragRecallText,
      essential: false,
      flexibleRank: 5, // 比非本章预警（rank 4）还先砍——召回是锦上添花
    })
  }

  return sections
}

/** 预算兜底裁剪（#12 第 3/4 节）：先降档、仍超再整段移除，刚需绝不砍 */
function applyBudgetTrim(
  config: BookConfig,
  sections: MaterialSection[],
  trimLog: string[],
): { estimatedTokens: number; trimmed: boolean } {
  const budget = config.budget.input_per_chapter ?? 80000
  let totalTokens = sections.reduce((sum, s) => sum + estimateTokens(s.content), 0)
  let trimmed = false

  if (totalTokens > budget) {
    // 按弹性优先级从高到低处理（#4→#3→#2→#1）：先降档（减量保留），仍超再整段移除
    const flexSections = sections
      .filter((s) => !s.essential && s.flexibleRank !== undefined)
      .sort((a, b) => b.flexibleRank! - a.flexibleRank!)

    // 第一轮：有降档版的先降一档（减量保留连贯性）
    for (const s of flexSections) {
      if (totalTokens <= budget) break
      if (s.degradedContent !== undefined && s.content !== s.degradedContent) {
        const before = estimateTokens(s.content)
        s.content = s.degradedContent
        totalTokens -= before - estimateTokens(s.content)
        trimmed = true
        trimLog.push(`${s.title}（降档）`)
      }
    }

    // 第二轮：仍超预算 → 从弹性末位往前整段移除
    for (const s of flexSections) {
      if (totalTokens <= budget) break
      const idx = sections.indexOf(s)
      if (idx === -1) continue
      const sectionTokens = estimateTokens(s.content)
      sections.splice(idx, 1)
      totalTokens -= sectionTokens
      trimmed = true
      trimLog.push(`${s.title}（移除，约 ${sectionTokens} token）`)
    }
  }

  return { estimatedTokens: totalTokens, trimmed }
}

/** 合并文本 + 头部留痕 */
function serializeSections(
  sections: MaterialSection[],
  trimmed: boolean,
  trimLog: string[],
): string {
  const lines: string[] = []
  if (trimmed) {
    lines.push(`> ⚠ 因预算裁剪：${trimLog.join('、')}。可运行 read 补充。`)
    lines.push('')
  }
  for (const s of sections) {
    lines.push(`## ${s.title}`)
    lines.push(s.content)
    lines.push('')
  }
  return lines.join('\n')
}
