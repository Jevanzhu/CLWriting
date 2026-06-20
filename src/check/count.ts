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
  /** 对话提示语占对话行比例上限，0-1 */
  maxDialogueTagRatio?: number
  /** 连续同构排比句式上限 */
  maxParallelStreak?: number
  /** 是否检查结尾总结体 */
  avoidSummaryEnding?: boolean
  /** 文风铁律里的反和解/硬禁词清单，命中即红 */
  bannedWords?: string[]
}

/** 从 文风铁律.md 解析可量化硬约束阈值 + 反和解硬禁词（#5 第 8 节）。 */
export function parseIronRules(text: string): IronRules {
  const rules: IronRules = {}
  const lenM = text.match(/单句上限字数[:：]\s*(\d+)/)
  if (lenM) rules.maxSentenceLen = Number(lenM[1])
  const stackM = text.match(/形容词连续堆叠上限[:：]\s*(\d+)/)
  if (stackM) rules.maxAdjStack = Number(stackM[1])
  const tagRatioM = text.match(/对话标签占比[:：]\s*(\d+(?:\.\d+)?%?)/)
  if (tagRatioM) rules.maxDialogueTagRatio = parseRatio(tagRatioM[1]!)
  const parallelM = text.match(/排比连续数[:：]\s*(\d+)/)
  if (parallelM) rules.maxParallelStreak = Number(parallelM[1])
  if (/结尾总结体[:：]\s*(禁止|避免|少用)/.test(text)) rules.avoidSummaryEnding = true
  const bannedWords = parseAntiReconciliationWords(text)
  if (bannedWords.length > 0) rules.bannedWords = bannedWords
  return rules
}

/**
 * 文风机检纯统计（文风方案 §4.2，体检报告重扫用）。
 *
 * 把 checkStyleMetrics 的「判定 + 推 CheckItem」拆成两层：本函数只算数值指纹，
 * checkStyleMetrics 内部委托它再包装成 CheckItem（DRY + 守 439 绿）。
 *
 * 字段口径以现 checkStyleMetrics 实现为准（文风方案 §4.2 表为意向非契约）：
 * - overlongRatio：超 maxSentenceLen 的句子数 / 总句数；无 maxSentenceLen 时记 0
 * - adjStackHits：形容词堆叠去重命中数（与 checkStyleMetrics 的 new Set 口径一致）
 * - dialogueTagRatio：对话行中被标签修饰的占比（分母=含引号的对话行数，非全文）
 * - parallelStreakMax：最大同构排比连续数（补全统计；checkStyleMetrics 仍按首次越界推一条）
 * - summaryEnding：结尾 140 字是否命中总结体套路
 *
 * `_dialogueLines` 是内部辅助字段（对话行总数，供 checkStyleMetrics 判"有无对话行"不崩），外部聚合不用。
 */
export interface StyleStats {
  overlongRatio: number
  adjStackHits: number
  dialogueTagRatio: number
  parallelStreakMax: number
  summaryEnding: boolean
  /** 对话行总数（>0 才允许 dialogueTagRatio 有意义）；内部用，聚合层可忽略 */
  _dialogueLines: number
}

/** 纯统计函数：对正文算文风 5 维数值指纹，不产 CheckItem（文风方案 §4.2） */
export function computeStyleMetrics(body: string, rules: IronRules): StyleStats {
  // 单句超限占比
  let overlongRatio = 0
  if (rules.maxSentenceLen && rules.maxSentenceLen > 0) {
    const sentences = body.split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s.length > 0)
    if (sentences.length > 0) {
      const overlong = sentences.filter((s) => s.length > rules.maxSentenceLen!).length
      overlongRatio = overlong / sentences.length
    }
  }

  // 形容词堆叠去重命中数
  let adjStackHits = 0
  if (rules.maxAdjStack && rules.maxAdjStack > 0) {
    const stackRe = adjStackRegex(rules.maxAdjStack)
    const hits = body.match(stackRe)
    if (hits) adjStackHits = new Set(hits).size
  }

  // 对话标签占比（分母=对话行数）
  let dialogueTagRatio = 0
  const dialogueLines = body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /[「『“"][^」』”"]+[」』”"]/.test(line))
  if (rules.maxDialogueTagRatio !== undefined && dialogueLines.length > 0) {
    const tagRe = new RegExp(`[${HANZI}]{1,8}(说|道|问|喊|叫|答|叹|笑)(了|着)?`, 'u')
    const tagged = dialogueLines.filter((line) => tagRe.test(line)).length
    dialogueTagRatio = tagged / dialogueLines.length
  }

  // 最大同构排比连续数（补全统计，不同于 checkStyleMetrics 的"首次越界即 break"）
  let parallelStreakMax = 0
  if (rules.maxParallelStreak !== undefined && rules.maxParallelStreak > 0) {
    const sentences = body.split(/[。！？；\n]/).map((s) => s.trim()).filter(Boolean)
    let prev = ''
    let streak = 0
    for (const sentence of sentences) {
      const prefix = sentence.match(new RegExp(`^[${HANZI}]{2}`, 'u'))?.[0] ?? ''
      if (prefix && prefix === prev) {
        streak += 1
      } else {
        prev = prefix
        streak = prefix ? 1 : 0
      }
      if (streak > parallelStreakMax) parallelStreakMax = streak
    }
  }

  // 结尾总结体
  let summaryEnding = false
  if (rules.avoidSummaryEnding) {
    const ending = body.trim().slice(-140)
    summaryEnding = summaryEndingRegex().test(ending)
  }

  return {
    overlongRatio,
    adjStackHits,
    dialogueTagRatio,
    parallelStreakMax,
    summaryEnding,
    _dialogueLines: dialogueLines.length,
  }
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
  const stats = computeStyleMetrics(body, rules)
  const items: CheckItem[] = []

  // 单句超铁律上限（逐句推一条，保持原行为）
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

  // 形容词连续堆叠：去重后逐个推（保持原行为）
  if (rules.maxAdjStack && rules.maxAdjStack > 0) {
    const stackRe = adjStackRegex(rules.maxAdjStack)
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

  // 对话标签占比：用 stats 算好的 ratio（口径与原实现一致，分母=对话行数）
  if (rules.maxDialogueTagRatio !== undefined && stats.dialogueTagRatio > rules.maxDialogueTagRatio && stats._dialogueLines > 0) {
    items.push({
      checkId: 'style-dialogue-tag-ratio',
      level: 'yellow',
      message: `对话标签占比 ${(stats.dialogueTagRatio * 100).toFixed(0)}% 超文风铁律上限 ${(rules.maxDialogueTagRatio * 100).toFixed(0)}%，可增加无标签对话。`,
    })
  }

  // 连续同构排比：首次越界即推一条 + break（保持原行为；max 留在 stats 供聚合用）
  if (rules.maxParallelStreak !== undefined && rules.maxParallelStreak > 0 && stats.parallelStreakMax > rules.maxParallelStreak) {
    // 复算首个越界 prefix（与原实现一致的消息文案）
    const sentences = body.split(/[。！？；\n]/).map((s) => s.trim()).filter(Boolean)
    let prev = ''
    let streak = 0
    let hitPrefix = ''
    for (const sentence of sentences) {
      const prefix = sentence.match(new RegExp(`^[${HANZI}]{2}`, 'u'))?.[0] ?? ''
      if (prefix && prefix === prev) {
        streak += 1
      } else {
        prev = prefix
        streak = prefix ? 1 : 0
      }
      if (streak > rules.maxParallelStreak) {
        hitPrefix = prefix
        break
      }
    }
    items.push({
      checkId: 'style-parallel-streak',
      level: 'yellow',
      message: `连续同构排比「${hitPrefix}…」超过 ${rules.maxParallelStreak} 句，建议打散节奏。`,
    })
  }

  // 结尾总结体
  if (rules.avoidSummaryEnding && stats.summaryEnding) {
    items.push({
      checkId: 'style-summary-ending',
      level: 'yellow',
      message: '结尾疑似总结体，可改成动作、物件或余韵画面收束。',
    })
  }

  return { name: '文风可量化', items }
}

function parseRatio(raw: string): number {
  const text = raw.trim()
  const n = Number(text.replace('%', ''))
  if (!Number.isFinite(n)) return 0
  return text.endsWith('%') ? n / 100 : n > 1 ? n / 100 : n
}

function adjStackRegex(maxAdjStack: number): RegExp {
  return new RegExp(`(?:[${HANZI}]{1,6}的(?:[、，,]\\s*)?){${maxAdjStack + 1},}`, 'gu')
}

function summaryEndingRegex(): RegExp {
  return /(这一刻|那一刻|这一战|此役|从此|直到很久以后|多年以后|命运|人生|终于明白|原来).*(明白|懂得|领悟|真谛|道理|命运|人生|结束|开始|答案)/
}

function parseAntiReconciliationWords(text: string): string[] {
  const section = extractSection(text, /反和解/)
  if (!section) return []

  const words: string[] = []
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('>') || /待作者补|待补|示例|非硬禁词/.test(line)) continue

    const quoted = [...line.matchAll(/[「『“"]([^」』”"]{2,24})[」』”"]/g)].map((m) => m[1]!)
    if (quoted.length > 0) {
      words.push(...quoted)
      continue
    }

    const cleaned = line
      .replace(/^[-*+]\s*/, '')
      .replace(/^\d+[.)、]\s*/, '')
      .replace(/^(禁止|禁用|不要|不得|避免|少用)\s*/, '')
      .replace(/[（(].*?[）)]/g, '')
      .trim()
    if (!cleaned || /[:：]/.test(cleaned)) continue

    for (const part of cleaned.split(/[、，,\/／]/)) {
      const word = part.trim()
      if (word.length >= 2 && word.length <= 24 && !/待/.test(word)) words.push(word)
    }
  }
  return [...new Set(words)]
}

function extractSection(text: string, headingRe: RegExp): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inSection = false
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      if (inSection) break
      if (headingRe.test(line)) {
        inSection = true
        continue
      }
    }
    if (inSection) out.push(line)
  }
  return out.join('\n').trim()
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

// ── 短篇专属机检项（M8 #27 第 5.3 节，新增）──────────
//
// 短篇目标函数是单篇情绪爆破，4 项专属软约束（吸收点 7.1）：
// 身体部位词 ≤5 / 「像」≤10 / 节数守恒=5 / 开头零环境。
// 全部零 token 脚本判定，黄项只报不拦（ask 不 deny）。

/** 短篇正文 front matter 检查（#27 第 6 节，🔴 红）。
 *  篇号必填、标题非空。与长篇 checkFrontMatter 分轨（短篇无钩子/情绪定位枚举）。 */
export function checkPieceFrontMatter(
  piece: { 篇号: number; 标题: string },
  fileName: string,
): CheckSectionResult {
  const items: CheckItem[] = []
  // 篇号 == 文件名前缀（篇/001-标题/正文.md → 取 001）
  const fileNum = Number(fileName.match(/(\d+)-/)?.[1])
  if (!Number.isNaN(fileNum) && fileNum !== piece.篇号) {
    items.push({
      checkId: 'fm-piece-mismatch',
      level: 'red',
      message: `篇号「${piece.篇号}」与文件名「${fileName}」前缀不一致`,
    })
  }
  if (!piece.标题) {
    items.push({ checkId: 'fm-piece-title', level: 'red', message: '缺少标题' })
  }
  return { name: '短篇 front matter', items }
}

/** 短篇字数阈值（#27 第 5.2 节，🟡 黄）。
 *  总字数 8000–20000（工单第 0 节）；阈值待 beta 校准，本期定方向。 */
export function checkPieceWordCount(
  actualWords: number,
  min = 8000,
  max = 20000,
): CheckSectionResult {
  const items: CheckItem[] = []
  if (actualWords < min) {
    items.push({
      checkId: 'piece-word-short',
      level: 'yellow',
      message: `字数 ${actualWords} 低于短篇下限 ${min}（短篇目标 8000–20000）`,
    })
  } else if (actualWords > max) {
    items.push({
      checkId: 'piece-word-long',
      level: 'yellow',
      message: `字数 ${actualWords} 超过短篇上限 ${max}（短篇目标 8000–20000）`,
    })
  }
  return { name: '短篇字数', items }
}

/** 默认身体部位词表（吸收点 7.1 正文洁净，AI 味堆砌高发项） */
const DEFAULT_BODY_PARTS = ['眼睛', '眼神', '眼眶', '手指', '手掌', '心脏', '心跳', '脸庞', '嘴角', '眉头', '喉咙', '呼吸']

/**
 * 身体部位词检查（#27 第 5.3 节，🟡 黄）。
 * 正文洁净：眼/手/心脏等堆砌计数超阈报黄（AI 味高发）。
 */
export function checkBodyParts(
  body: string,
  threshold = 5,
  words: string[] = DEFAULT_BODY_PARTS,
): CheckSectionResult {
  const items: CheckItem[] = []
  const over: string[] = []
  for (const word of words) {
    if (!word) continue
    let count = 0
    let idx = body.indexOf(word)
    while (idx !== -1) {
      count++
      idx = body.indexOf(word, idx + word.length)
    }
    if (count > threshold) over.push(`${word}×${count}`)
  }
  if (over.length > 0) {
    items.push({
      checkId: 'body-parts',
      level: 'yellow',
      message: `身体部位词堆砌超阈（≤${threshold}）：${over.join('、')}`,
    })
  }
  return { name: '身体部位词', items }
}

/**
 * 「像」比喻密度检查（#27 第 5.3 节，🟡 黄）。
 * 比喻泛滥计数：以「像」开头的比喻句超阈报黄。
 */
export function checkSimile(
  body: string,
  threshold = 10,
): CheckSectionResult {
  const items: CheckItem[] = []
  // 统计「像」字出现次数（粗计；精确判定比喻句需语义，零 token 取近似）
  let count = 0
  let idx = body.indexOf('像')
  while (idx !== -1) {
    count++
    idx = body.indexOf('像', idx + 1)
  }
  if (count > threshold) {
    items.push({
      checkId: 'simile-density',
      level: 'yellow',
      message: `「像」出现 ${count} 次超阈值（≤${threshold}），比喻泛滥疑似 AI 味`,
    })
  }
  return { name: '比喻密度', items }
}

/**
 * 节数守恒检查（#27 第 5.3 节，🟡 黄）。
 * 正文实际节数（按空行切块）与五段结构一致。严重不符可定红（阈值实现期定）。
 */
export function checkSectionCount(
  body: string,
  expected = 5,
): CheckSectionResult {
  const items: CheckItem[] = []
  // 按 markdown ## 标题或连续空行切块
  const byHeading = body.split(/^##\s/m).filter((s) => s.trim().length > 0)
  let sections: number
  if (byHeading.length >= 2) {
    // 有 ## 标题：按标题数
    sections = byHeading.length
  } else {
    // 无标题：按双空行切块
    sections = body.split(/\n\s*\n/).filter((s) => s.trim().length > 0).length
  }
  if (sections !== expected) {
    items.push({
      checkId: 'section-count',
      level: 'yellow',
      message: `正文 ${sections} 节，五段结构期望 ${expected} 节（节数守恒）`,
    })
  }
  return { name: '节数守恒', items }
}

/** 默认环境描写关键词表（黄金 300 字直入钩子，吸收点 7.1） */
const DEFAULT_ENV_WORDS = ['天气', '阳光', '月光', '日升', '日落', '天空', '云层', '风声', '雨声', '景色', '远山', '树林', '街道', '建筑']

/**
 * 开头零环境检查（#27 第 5.3 节，🟡 黄）。
 * 黄金 300 字直入钩子：开篇 300 字命中环境描写词报黄。
 */
export function checkOpeningNoEnv(
  body: string,
  openingChars = 300,
  envWords: string[] = DEFAULT_ENV_WORDS,
): CheckSectionResult {
  const items: CheckItem[] = []
  const opening = body.slice(0, openingChars)
  const hits: string[] = []
  for (const word of envWords) {
    if (word && opening.includes(word)) hits.push(word)
  }
  if (hits.length > 0) {
    items.push({
      checkId: 'opening-env',
      level: 'yellow',
      message: `开头 ${openingChars} 字出现环境描写（${hits.slice(0, 3).join('、')}），黄金 300 字应直入钩子`,
    })
  }
  return { name: '开头零环境', items }
}
