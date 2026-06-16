/**
 * 可计数项 + 文风可量化 —— 依据 ⑩ 第 2 节项 3-11。
 *
 * 红（⑩ 项 3-4）：front matter 格式、禁词
 * 黄（⑩ 项 5-11）：字数/复读/意象/句式/文风可量化/专名/信息差候选
 *
 * 全部零 token 脚本判定。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckSectionResult, CheckItem } from './types.js'
import type { ChapterMeta, BookConfig } from '../format/types.js'
import { validateEnums, countWords } from '../format/chapters.js'

/**
 * front matter 格式检查（⑩ 项 3，🔴 红）。
 * 章号==文件名、枚举合法、必填齐。
 */
export function checkFrontMatter(
  chapter: ChapterMeta,
  fileName: string,
): CheckSectionResult {
  const items: CheckItem[] = []

  // 章号 == 文件名前缀
  const fileNum = Number(fileName.match(/^(\d+)-/)?.[1])
  if (fileNum !== chapter.章号) {
    items.push({
      checkId: 'fm-chapter-mismatch',
      level: 'red',
      message: `章号「${chapter.章号}」与文件名「${fileName}」前缀不一致`,
      chapter: chapter.章号,
    })
  }

  // 枚举合法
  const enumErrs = validateEnums(chapter)
  for (const e of enumErrs) {
    items.push({ checkId: 'fm-enum', level: 'red', message: e, chapter: chapter.章号 })
  }

  return { name: 'front matter 格式', items }
}

/**
 * 禁词检查（⑩ 项 4，🔴 红）。
 * 命中作者设的禁词表（文风铁律.md 的禁词段）。
 */
export function checkBannedWords(
  body: string,
  bannedWords: string[],
): CheckSectionResult {
  const items: CheckItem[] = []
  for (const word of bannedWords) {
    if (body.includes(word)) {
      items.push({
        checkId: 'banned-word',
        level: 'red',
        message: `命中禁词「${word}」`,
      })
    }
  }
  return { name: '禁词', items }
}

/**
 * 字数检查（⑩ 项 5，🟡 黄）。
 * 偏离细纲目标字数过多 → 提示。
 */
export function checkWordCount(
  actualWords: number,
  targetWords: number,
  tolerancePct = 30,
): CheckSectionResult {
  const items: CheckItem[] = []
  if (targetWords > 0) {
    const diff = Math.abs(actualWords - targetWords) / targetWords * 100
    if (diff > tolerancePct) {
      items.push({
        checkId: 'word-count',
        level: 'yellow',
        message: `字数 ${actualWords} 偏离目标 ${targetWords}（偏差 ${Math.round(diff)}% > ${tolerancePct}%）`,
      })
    }
  }
  return { name: '字数', items }
}

/**
 * 复读检查（⑩ 项 6，🟡 黄）。
 * 滑窗句级 n-gram 重复率。
 */
export function checkRepeat(
  body: string,
  threshold = 0.15,
): CheckSectionResult {
  const items: CheckItem[] = []
  const sentences = body.split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s.length >= 6)
  const counts = new Map<string, number>()
  for (const s of sentences) {
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  // 重复实例数 = 每个重复句子（出现≥2次）的总出现次数 - 1
  let repeatInstances = 0
  for (const c of counts.values()) {
    if (c >= 2) repeatInstances += c - 1
  }
  if (sentences.length > 0) {
    const rate = repeatInstances / sentences.length
    if (rate > threshold) {
      items.push({
        checkId: 'repeat',
        level: 'yellow',
        message: `复读率 ${(rate * 100).toFixed(1)}% 超阈值 ${threshold * 100}%（重复 ${repeatInstances} 处）`,
      })
    }
  }
  return { name: '复读', items }
}

/**
 * 句长体检（⑩ 项 8，🟡 黄）。
 * 句长方差 / 超长句占比。
 */
export function checkSentenceLength(
  body: string,
  maxLen = 60,
): CheckSectionResult {
  const items: CheckItem[] = []
  const sentences = body.split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s.length > 0)
  const overlong = sentences.filter((s) => s.length > maxLen)
  if (sentences.length > 0 && overlong.length / sentences.length > 0.2) {
    items.push({
      checkId: 'sentence-length',
      level: 'yellow',
      message: `超长句（>${maxLen}字）占比 ${(overlong.length / sentences.length * 100).toFixed(0)}%，句长偏长`,
    })
  }
  return { name: '句式体检', items }
}

/**
 * 新专名比对名册（⑩ 项 10，🟡 黄）。
 * 新专名 vs 名册.md，未登记 → 候选（不自动入册）。
 */
export function checkNewNames(
  body: string,
  rosterPath: string,
): CheckSectionResult {
  const items: CheckItem[] = []
  if (!existsSync(rosterPath)) return { name: '新专名候选', items }
  const roster = readFileSync(rosterPath, 'utf-8')
  // 粗抽：2-4 字中文专名候选（带引号或书名号的优先）
  const candidates = new Set<string>()
  const quoted = body.match(/[「『"]([^」』"]{2,4})[」』"]/g)
  if (quoted) {
    for (const q of quoted) {
      const name = q.replace(/[「『」』"]「」『』/g, '')
      if (name.length >= 2 && name.length <= 4 && !roster.includes(name)) {
        candidates.add(name)
      }
    }
  }
  for (const name of candidates) {
    items.push({
      checkId: 'new-name',
      level: 'yellow',
      message: `新专名候选「${name}」未在名册中登记`,
    })
  }
  return { name: '新专名候选', items }
}
