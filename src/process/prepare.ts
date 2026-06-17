/**
 * 备料 + 输入预算闸 —— 阶段 3（母本第 6.3 节，依据 #12 输入预算闸 spec）。
 *
 * 组装写稿材料：近况 + 本章账本推进条目 + 设定边界 + 文风铁律 + 文风样章 + 近章结尾。
 *
 * 预算闸（#12）：
 * 1. 源头限流——账本只取本章细纲声明推进的条目 + 少数悬太久（不取全部 open）
 * 2. 兜底裁剪——超预算按弹性优先级 #4→#3→#2→#1 先降档（减量保留）、仍超再整段移除，刚需绝不砍
 * 3. 软预算——不硬拒，裁剪 + 头部留痕
 */

import type { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { assembleStatus, formatStatus } from './assemble.js'
import { readLeadHistory, readChapterSummaries } from '../cli/read.js'
import { readSamplesByScene } from '../format/style.js'
import type { BookConfig, LeadType } from '../format/types.js'

/** 写作材料的各段（按裁剪优先级标注刚需/弹性） */
export interface MaterialSection {
  /** 段标题 */
  title: string
  /** 段内容 */
  content: string
  /** 刚需（永不裁剪）还是弹性（可降档/裁剪） */
  essential: boolean
  /** 弹性优先级（#12 第 4 节，数字越大越先砍：4=非本章预警, 3=远期摘要, 2=文风样章, 1=近章结尾） */
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
 * 备料组装 + 预算闸。
 *
 * @param db 缓存
 * @param config book.yaml
 * @param bookRoot 书仓库根
 * @param chapterLeadIds 本章细纲声明推进的账本条目 id（#12 第 2 节#2 源头限流）
 */
export function prepare(
  db: DatabaseSync,
  config: BookConfig,
  bookRoot: string,
  chapterLeadIds: string[],
): PrepareResult {
  const sections: MaterialSection[] = []
  const trimLog: string[] = []

  // ── 刚需段（#12 第 4 节：永不裁剪）──────────────

  // #1 近况（刚需——AI 必须知道写到哪里了）
  const snapshot = assembleStatus(db, config)
  sections.push({
    title: '近况',
    content: formatStatus(snapshot),
    essential: true,
  })

  // #2 本章账本推进条目（刚需——#12 第 2 节#2 源头限流：只取本章涉及的）
  if (chapterLeadIds.length > 0) {
    const parts: string[] = []
    for (const id of chapterLeadIds) {
      const history = readLeadHistory(db, id)
      parts.push(`【${id}】`)
      for (const h of history.slice(-3)) {
        // 只取最近 3 条履历（源头限流）
        parts.push(`  第${h.章号}章 ${h.动词}：${h.证据}`)
      }
    }
    sections.push({
      title: '本章推进的账本',
      content: parts.join('\n'),
      essential: true,
    })
  }

  // #3 文风铁律（刚需——#12 含反和解标准段）
  const ironPath = join(bookRoot, '文风', '文风铁律.md')
  if (existsSync(ironPath)) {
    sections.push({
      title: '文风铁律',
      content: readFileSync(ironPath, 'utf-8').trim(),
      essential: true,
    })
  }

  // ── 弹性段（#12 第 4 节：可裁剪，按优先级）──────

  // 弹性#1 近章结尾（缩 1-2 章，flexibleRank=1，最后才砍；降档=只留最近 1 章）
  const recentEndings = readChapterSummaries(db, Math.max(1, snapshot.currentChapter - 1), snapshot.currentChapter)
  if (recentEndings.length > 0) {
    const parts: string[] = []
    for (const r of recentEndings) {
      if (existsSync(r.path)) {
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

  // 弹性#2 文风样章（降浓度，flexibleRank=2；降档=只留 1 段）
  const sampleDir = join(bookRoot, '文风', '样章库')
  const { samples } = readSamplesByScene(sampleDir, '战斗') // 场景由细纲定，M2 桩用战斗
  if (samples.length > 0) {
    // 轻注入：只取 1-2 段（#12 + 母本第 1.4 节）
    const injected = config.style.injection === 'heavy' ? samples.slice(0, 3) : samples.slice(0, 1)
    const parts = injected.map((s) => s.正文)
    sections.push({
      title: '文风样章',
      content: parts.join('\n\n'),
      essential: false,
      flexibleRank: 2,
      degradedContent: parts.slice(0, 1).join('\n\n'),
    })
  }

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

  // ── 预算兜底裁剪（#12 第 3/4 节）────────────────

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

  // ── 合并文本 + 头部留痕 ────────────────────────

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

  return {
    sections,
    text: lines.join('\n'),
    estimatedTokens: totalTokens,
    trimmed,
    trimLog,
  }
}
