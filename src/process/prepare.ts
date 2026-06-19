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
import type { BookConfig, LeadType, StyleSample } from '../format/types.js'

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
  const sections: MaterialSection[] = []
  const trimLog: string[] = []

  // ── 刚需段（#12 第 4 节：永不裁剪）──────────────

  // #1 近况（刚需——AI 必须知道写到哪里了）
  const snapshot = assembleStatus(db, config, config.book.volume_size ?? 50)
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
  // G2 跨场景：主场景优先、次场景补，总量受注入档约束（轻 1 段 / 重 3 段，母本第 1.4 节）
  const sampleDir = join(bookRoot, '文风', '样章库')
  const scenes = Array.isArray(sampleScene) ? sampleScene : [sampleScene]
  const perScene = scenes.map((sc) => readSamplesByScene(sampleDir, sc).samples)
  const maxTotal = config.style.injection === 'heavy' ? 3 : 1
  // 第一轮：每场景各取 1（保证次场景有代表）；第二轮：主场景补满到 maxTotal
  const picked: StyleSample[] = []
  for (const samples of perScene) {
    if (samples.length > 0) picked.push(samples[0]!)
  }
  for (let i = 1; picked.length < maxTotal && i < (perScene[0]?.length ?? 0); i++) {
    picked.push(perScene[0]![i]!)
  }
  const injected = picked.slice(0, maxTotal)
  if (injected.length > 0) {
    const parts = injected.map((s) => {
      if (!s.技法指令) return s.正文
      return `技法指令：${s.技法指令}\n${s.正文}`
    })
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
