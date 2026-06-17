/**
 * 机检总 runner —— 依据 #10 机检规则 spec。
 *
 * 聚合 #10 第 2 节全部 11 项检查（红 4 项 + 黄 7 项）→ CheckReport。
 * 红 > 0 → 自愈打回（#10 第 6 节）。
 * 顺带产出账本变动清单 / 信息差候选 / 新专名候选（#10 第 2 节末，供阶段 6 三审）。
 */

import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import type { CheckReport, CheckSectionResult } from './types.js'
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
  checkImagery,
  checkStyleMetrics,
  checkInfoLeak,
  parseIronRules,
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
  declaredLeadIds?: string[] // 本章细纲声明推进的账本编号（两端闭合，#10 项 1）
  actualLeadIds?: string[] // 本章实际写入履历的账本编号（两端闭合对照侧）
  imageryWords?: string[] // 高频意象表（#10 项 7，默认空，数据待 M4 知识层平移）
  leakKeywords?: string[] // 信息差关键词（#10 项 11，默认空，数据源待定）
}

/** 跑全套机检（#10 第 2 节 11 项）→ CheckReport */
export function runAllChecks(input: CheckInput): CheckReport {
  const { db, bookRoot, config, chapter, body, fileName } = input
  const sections: CheckSectionResult[] = []

  // 当前章号
  const currentChapter = chapter.章号

  // 已启用类 = 基础三类 + book.yaml enabled
  const enabledTypes = ['伏笔', '悬念', '感情线', ...config.leads.enabled]

  // #10 项 1 账本形式三检（红）—— 章号一致 / 引文命中 / 状态闭合 / 两端闭合
  sections.push(
    checkLeadsForm(db, bookRoot, currentChapter, enabledTypes, input.declaredLeadIds, input.actualLeadIds),
  )

  // #10 项 2 成长线语义（红）—— 仅启用成长线时
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

  // #10 项 3 front matter 格式（红）
  sections.push(checkFrontMatter(chapter, fileName))

  // #10 项 4 禁词（红）
  sections.push(checkBannedWords(body, input.bannedWords ?? []))

  // #10 项 5 字数（黄）
  sections.push(checkWordCount(chapter._wordCount ?? countWords(body), input.targetWords ?? 0))

  // #10 项 6 复读（黄）
  sections.push(checkRepeat(body))

  // #10 项 7 高频意象（黄）
  sections.push(checkImagery(body, input.imageryWords ?? []))

  // #10 项 8 句式体检（黄）
  sections.push(checkSentenceLength(body))

  // #10 项 9 文风可量化（黄）—— 读 文风铁律.md 的可量化硬约束阈值（#5 第 8 节）
  const ironPath = join(bookRoot, '文风', '文风铁律.md')
  const ironRules = existsSync(ironPath) ? parseIronRules(readFileSync(ironPath, 'utf-8')) : {}
  sections.push(checkStyleMetrics(body, ironRules))

  // #10 项 10 新专名候选（黄）
  const rosterPath = join(bookRoot, '定稿', '设定', '名册.md')
  sections.push(checkNewNames(body, rosterPath))

  // #10 项 11 信息差泄密候选（黄）
  sections.push(checkInfoLeak(body, input.leakKeywords ?? []))

  // 顺带产出（#10 第 2 节末）：账本变动清单 + 信息差候选 + 新专名候选 → 供阶段 6 三审
  const byproducts = collectByproducts(sections, db, currentChapter, enabledTypes)

  return { sections, byproducts }
}

/** 收集机检顺带产出（#10 第 2 节末）：本章账本变动清单 + 信息差/新专名候选。 */
function collectByproducts(
  sections: CheckSectionResult[],
  db: DatabaseSync,
  currentChapter: number,
  enabledTypes: string[],
): CheckReport['byproducts'] {
  const infoLeakCandidates: string[] = []
  const newNames: string[] = []
  for (const s of sections) {
    for (const i of s.items) {
      if (i.checkId === 'info-leak-candidate') infoLeakCandidates.push(i.message)
      else if (i.checkId === 'new-name') newNames.push(i.message)
    }
  }

  // 本章账本变动清单（本章已入库的履历，按已启用类）
  const placeholders = enabledTypes.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT lh.lead_id AS leadId, lh.chapter AS chapter, lh.verb AS verb, lh.evidence AS evidence
     FROM lead_history lh JOIN leads l ON l.id = lh.lead_id
     WHERE lh.chapter = ? AND l.type IN (${placeholders})
     ORDER BY lh.lead_id`,
  ).all(currentChapter, ...enabledTypes) as Record<string, unknown>[]
  const leadChanges = rows.map((r) => ({
    leadId: r['leadId'] as string,
    chapter: r['chapter'] as number,
    verb: r['verb'] as string,
    evidence: r['evidence'] as string,
  }))

  return { leadChanges, infoLeakCandidates, newNames }
}

/** 导出 hasRed/getRedItems 方便调用方 */
export { hasRed, getRedItems }
