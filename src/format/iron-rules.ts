/**
 * 文风铁律配置解析（第八轮方案 P2-A1：消除 format→check 循环依赖）。
 *
 * 从 文风铁律.md 解析可量化硬约束阈值 + 反和解硬禁词（#5 第 8 节）。
 * 纯文本解析、零依赖——format 基础层可安全引用（check/count.js 反向依赖 format，
 * 不可在 format 内 import check）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readBannedEntryWords } from './style-entry.js'

/** 文风铁律可量化硬约束（parseIronRules 输出） */
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
 * RB-KN-P1-1：读铁律阈值 + 条目库禁词合并——单一真相源（原先 check/runner 私有版
 * 只读铁律不合并条目库，而 S5 迁移已把禁词知识搬进条目库并瘦身铁律，迁移书的
 * checkBannedWords 红项因此恒空、禁词拦截与自愈打回整体失效）。
 * metrics/style 与 check/runner 均消费此实现；皆无 → 空规则。
 */
export function readIronRules(bookRoot: string): IronRules {
  const p = join(bookRoot, '文风', '文风铁律.md')
  const rules = existsSync(p) ? parseIronRules(readFileSync(p, 'utf-8')) : {}
  const entryWords = readBannedEntryWords(bookRoot)
  if (entryWords.length > 0) {
    rules.bannedWords = [...new Set([...(rules.bannedWords ?? []), ...entryWords])]
  }
  return rules
}

function parseRatio(raw: string): number {
  const text = raw.trim()
  const n = Number(text.replace('%', ''))
  if (!Number.isFinite(n)) return 0
  return text.endsWith('%') ? n / 100 : n > 1 ? n / 100 : n
}

function parseAntiReconciliationWords(text: string): string[] {
  const sections = [
    extractSection(text, /反和解/),
    extractSection(text, /硬禁词|禁词清单/),
  ].filter((section) => section.length > 0)
  if (sections.length === 0) return []

  const words: string[] = []
  for (const section of sections) {
    for (const rawLine of section.split('\n')) {
      words.push(...parseBannedWordsLine(rawLine))
    }
  }
  return [...new Set(words)]
}

function parseBannedWordsLine(rawLine: string): string[] {
  const line = rawLine.trim()
  if (!line || line.startsWith('>') || /待作者补|待补|示例|非硬禁词/.test(line)) return []

  const quoted = [...line.matchAll(/[「『“"]([^」』”"]{2,24})[」』”"]/g)].map((m) => m[1]!)
  if (quoted.length > 0) return quoted

  let cleaned = line
    .replace(/^[-*+]\s*/, '')
    .replace(/^\d+[.)、]\s*/, '')
    .replace(/[（(].*?[）)]/g, '')
    .trim()

  const colon = cleaned.match(/^([^:：]{1,24})[:：]\s*(.+)$/)
  if (colon) {
    const label = colon[1]!.trim()
    const value = colon[2]!.trim()
    if (!/(禁止|禁用|不要|不得|避免|少用|硬禁词|禁词|禁句|套话|反和解|清单|词表|不可出现)/.test(label)) {
      return []
    }
    cleaned = value
  } else {
    cleaned = cleaned.replace(/^(禁止|禁用|不要|不得|避免|少用)\s+/, '').trim()
  }

  if (!cleaned) return []
  return cleaned
    .split(/[、，,\/／；;]/)
    .map((part) => part.trim())
    .filter((word) => word.length >= 2 && word.length <= 24 && !/待/.test(word))
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