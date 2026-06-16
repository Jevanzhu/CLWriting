/**
 * 机检总 runner —— 依据 ⑩ 机检规则 spec。
 *
 * 聚合全部 11 项检查 → CheckReport。
 * 红 > 0 → 自愈打回（⑩ 第 6 节）。
 */

import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import type { CheckReport, CheckSectionResult, CheckItem } from './types.js'
import { hasRed, getRedItems } from './types.js'
import { checkLeadsForm } from './leads.js'
import { checkGrowth } from './growth.js'
import {
  checkFrontMatter,
  checkBannedWords,
  checkWordCount,
  checkRepeat,
  checkSentenceLength,
  checkNewNames,
} from './count.js'
import { readRealmDoc } from '../format/realms.js'
import { countWords } from '../format/chapters.js'
import type { ChapterMeta, BookConfig, RealmDoc } from '../format/types.js'

/** 机检输入 */
export interface CheckInput {
  db: DatabaseSync
  bookRoot: string
  config: BookConfig
  chapter: ChapterMeta
  body: string // 正文
  fileName: string // 正文文件名
  targetWords?: number // 细纲目标字数
  bannedWords?: string[] // 禁词表
}

/** 跑全套机检 → CheckReport */
export function runAllChecks(input: CheckInput): CheckReport {
  const { db, bookRoot, config, chapter, body, fileName } = input
  const sections: CheckSectionResult[] = []

  // 当前章号
  const currentChapter = chapter.章号

  // 已启用类 = 基础三类 + book.yaml enabled
  const enabledTypes = ['伏笔', '悬念', '感情线', ...config.leads.enabled]

  // ⑩ 项 1 账本形式三检（红）
  sections.push(checkLeadsForm(db, bookRoot, currentChapter, enabledTypes))

  // ⑩ 项 2 成长线语义（红）—— 仅启用成长线时
  if (config.leads.enabled.includes('成长线')) {
    const realmPath = join(bookRoot, '定稿', '设定', '境界体系.md')
    let realmDoc: RealmDoc | null = null
    if (existsSync(realmPath)) {
      const r = readRealmDoc(realmPath)
      if (r.ok) realmDoc = r.doc
    }
    const growthIds = (db.prepare(
      `SELECT id FROM leads WHERE type = '成长线'`,
    ).all() as { id: string }[]).map((r) => r.id)
    sections.push(checkGrowth(db, realmDoc, growthIds, config.growth.realm_span_max ?? 2))
  }

  // ⑩ 项 3 front matter 格式（红）
  sections.push(checkFrontMatter(chapter, fileName))

  // ⑩ 项 4 禁词（红）
  sections.push(checkBannedWords(body, input.bannedWords ?? []))

  // ⑩ 项 5 字数（黄）
  sections.push(checkWordCount(chapter._wordCount ?? countWords(body), input.targetWords ?? 0))

  // ⑩ 项 6 复读（黄）
  sections.push(checkRepeat(body))

  // ⑩ 项 8 句式体检（黄）
  sections.push(checkSentenceLength(body))

  // ⑩ 项 10 新专名候选（黄）
  const rosterPath = join(bookRoot, '定稿', '设定', '名册.md')
  sections.push(checkNewNames(body, rosterPath))

  return { sections }
}

/** 导出 hasRed/getRedItems 方便调用方 */
export { hasRed, getRedItems }
