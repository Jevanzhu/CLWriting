/**
 * 可计数项 + 文风可量化 —— 依据 #10 第 2 节项 3-11。
 *
 * 红（#10 项 3-4）：front matter 格式、禁词
 * 黄（#10 项 5-11）：字数/复读/意象/句式/文风可量化/专名/信息差候选
 *
 * 全部零 token 脚本判定。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckSectionResult, CheckItem } from './types.js'
import type { ChapterMeta, BookConfig } from '../format/types.js'
import { validateEnums, countWords } from '../format/chapters.js'

/**
 * 汉字字符范围（基本区 + 扩展 A 区）。
 * 统一使用，避免不同检查项范围不一导致生僻字人名漏判。
 * 「一-鿿」= \u4e00-\u9fa5（基本区），「㐀-䶿」= \u3400-\u4dbf（扩展 A 区）。
 */
const HANZI = '一-鿿㐀-䶿'

/**
 * front matter 格式检查（#10 项 3，🔴 红）。
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
 * 禁词检查（#10 项 4，🔴 红）。
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
 * 字数检查（#10 项 5，🟡 黄）。
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
 * 复读检查（#10 项 6，🟡 黄）。
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
 * 句长体检（#10 项 8，🟡 黄）。
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
 * 新专名比对名册（#10 项 10，🟡 黄）。
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
      const name = q.replace(/[「『」』"]/g, '')
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

/**
 * 高频意象检查（#10 项 7，🟡 黄）。
 * 套路词/意象表命中频次超阈 → 提示（PRD 问题 9，"空气仿佛凝固"）。
 * 意象表默认空——初始数据靠 M4 知识层平移 / book.yaml 配置（#10 第 4/8 节待 beta）。
 */
export function checkImagery(
  body: string,
  imageryWords: string[] = [],
  threshold = 3,
): CheckSectionResult {
  const items: CheckItem[] = []
  for (const word of imageryWords) {
    if (!word) continue
    let count = 0
    let idx = body.indexOf(word)
    while (idx !== -1) {
      count++
      idx = body.indexOf(word, idx + word.length)
    }
    if (count >= threshold) {
      items.push({
        checkId: 'imagery-overuse',
        level: 'yellow',
        message: `高频意象「${word}」本章出现 ${count} 次（≥${threshold}），疑似套路堆叠`,
      })
    }
  }
  return { name: '高频意象', items }
}

/** 文风铁律可量化阈值（#5 第 8 节「## 可量化硬约束」段） */
export interface IronRules {
  /** 单句上限字数 */
  maxSentenceLen?: number
  /** 形容词连续堆叠上限 */
  maxAdjStack?: number
}

/** 从 文风铁律.md 解析可量化硬约束阈值（#5 第 8 节）。 */
export function parseIronRules(text: string): IronRules {
  const rules: IronRules = {}
  const lenM = text.match(/单句上限字数[:：]\s*(\d+)/)
  if (lenM) rules.maxSentenceLen = Number(lenM[1])
  const stackM = text.match(/形容词连续堆叠上限[:：]\s*(\d+)/)
  if (stackM) rules.maxAdjStack = Number(stackM[1])
  return rules
}

/**
 * 文风可量化检查（#10 项 9，🟡 黄）。
 * 贴近 文风铁律.md 的可量化硬约束：单句上限 / 形容词堆叠 / 对话提示语（#5 第 8 节）。
 * 阈值来自铁律；缺省项不检。零 token 启发式，只报不拦（ask 不 deny）。
 */
export function checkStyleMetrics(
  body: string,
  rules: IronRules,
): CheckSectionResult {
  const items: CheckItem[] = []

  // 单句超铁律上限
  if (rules.maxSentenceLen && rules.maxSentenceLen > 0) {
    const sentences = body.split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s.length > 0)
    for (const s of sentences) {
      if (s.length > rules.maxSentenceLen) {
        items.push({
          checkId: 'style-sentence-overlong',
          level: 'yellow',
          message: `单句 ${s.length} 字超文风铁律上限 ${rules.maxSentenceLen} 字：「${s.slice(0, 16)}…」`,
        })
      }
    }
  }

  // 形容词连续堆叠：超上限的连续「X的」
  if (rules.maxAdjStack && rules.maxAdjStack > 0) {
    const stackRe = new RegExp(`(?:[${HANZI}]{1,6}的){${rules.maxAdjStack + 1},}`, 'g')
    const hits = body.match(stackRe)
    if (hits) {
      for (const h of new Set(hits)) {
        items.push({
          checkId: 'style-adj-stack',
          level: 'yellow',
          message: `形容词堆叠超上限（${rules.maxAdjStack}）：「${h}」`,
        })
      }
    }
  }

  // 对话提示语堆叠（"…地说/地道"，优先"他说"，#5 第 8 节示例）
  const tagHits = body.match(new RegExp(`[${HANZI}]{2,}地(说|道)`, 'gu'))
  if (tagHits) {
    for (const t of new Set(tagHits)) {
      items.push({
        checkId: 'style-dialogue-tag',
        level: 'yellow',
        message: `对话提示语堆叠「${t}」，建议简化（优先"他${t.endsWith('说') ? '说' : '道'}"）`,
      })
    }
  }

  return { name: '文风可量化', items }
}

/**
 * 信息差泄密候选（#10 项 11，🟡 黄）。
 * 关键词命中 → 只出候选、不拦截（真伪归阶段 6 三审，PRD 问题 3）。
 * 关键词源默认空——由信息差设定 / book.yaml 提供（#10 第 2 节项 11）。
 */
export function checkInfoLeak(
  body: string,
  leakKeywords: string[] = [],
): CheckSectionResult {
  const items: CheckItem[] = []
  for (const kw of leakKeywords) {
    if (kw && body.includes(kw)) {
      items.push({
        checkId: 'info-leak-candidate',
        level: 'yellow',
        message: `信息差候选：正文出现「${kw}」，请确认是否提前泄露（真伪归三审）`,
      })
    }
  }
  return { name: '信息差候选', items }
}
