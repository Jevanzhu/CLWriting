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
  checkPieceFrontMatter,
  checkPieceWordCount,
  checkBodyParts,
  checkSimile,
  checkSectionCount,
  checkOpeningNoEnv,
} from './count.js'
import { checkPieceListForm } from './manifest-check.js'
import { readRealmDoc } from '../format/realms.js'
import { countWords } from '../format/chapters.js'
import { readPieceList } from '../format/manifest.js'
import type { ChapterMeta, BookConfig, RealmDoc, PieceList } from '../format/types.js'

/** 机检输入 */
export interface CheckInput {
  /** 缓存 db（长篇必填；短篇无 db，不传） */
  db?: DatabaseSync
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
  /** 短篇严格模式：把短篇专属黄项提升为红项，用于真实生产硬闸 */
  strictShort?: boolean
}

/**
 * 跑全套机检（#10 第 2 节 11 项）→ CheckReport。
 *
 * 按 `config.kind` 分支（M8 #27 第 5 节，H2 合并设计）：
 * - long（缺省）：长篇 11 项（账本/成长线/db 强依赖），行为逐字节不变
 * - short：跳账本/成长线/专名/信息差（长程项），跑通用项（禁词/复读/句式/文风）+ 短篇专属项（身体部位词/「像」/节数/开头零环境）+ 清单形式检
 */
export function runAllChecks(input: CheckInput): CheckReport {
  const { config, body, fileName } = input
  const isShort = (config.kind ?? 'long') === 'short'
  return isShort ? runShort(input) : runLong(input)
}

/** 长篇机检（#10 第 2 节 11 项，db 强依赖，行为逐字节不变） */
function runLong(input: CheckInput): CheckReport {
  const { db, bookRoot, config, chapter, body, fileName } = input
  if (!db) {
    // 长篇必须带 db（账本/成长线项强依赖）；防御性兜底
    throw new Error('runAllChecks: 长篇机检需要 db（缓存 index.db）')
  }
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

  // 文风铁律（禁词红项 + 可量化黄项）
  const ironRules = readIronRules(bookRoot)

  // #10 项 4 禁词（红）
  sections.push(checkBannedWords(body, mergeBannedWords(input.bannedWords, ironRules.bannedWords)))

  // #10 项 5 字数（黄）
  sections.push(checkWordCount(chapter._wordCount ?? countWords(body), input.targetWords ?? 0))

  // #10 项 6 复读（黄）
  sections.push(checkRepeat(body))

  // #10 项 7 高频意象（黄）
  sections.push(checkImagery(body, input.imageryWords ?? []))

  // #10 项 8 句式体检（黄）
  sections.push(checkSentenceLength(body))

  // #10 项 9 文风可量化（黄）—— 读 文风铁律.md 的可量化硬约束阈值（#5 第 8 节）
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

/**
 * 短篇机检（M8 #27 第 5 节）。
 *
 * 关闭长程项（账本形式三检/成长线/专名/信息差——短篇无长程载重），
 * 保留通用项（禁词/复读/句式/文风可量化），新增短篇专属项（身体部位词/「像」/节数/开头零环境），
 * 加跑清单形式检（反转线索 ≥3 铺垫、伏笔回收闭合）。
 * 零 db 依赖（短篇无缓存章表）。
 */
function runShort(input: CheckInput): CheckReport {
  const { bookRoot, chapter, body, fileName } = input
  const sections: CheckSectionResult[] = []

  // front matter（短篇口径：篇号 + 标题，无钩子/情绪枚举）
  // 短篇复用 ChapterMeta 内存模型（章号字段承载篇号），按短篇字段校验
  sections.push(checkPieceFrontMatter({ 篇号: chapter.章号, 标题: chapter.标题 }, fileName))

  const ironRules = readIronRules(bookRoot)

  // 禁词（长短通用）
  sections.push(checkBannedWords(body, mergeBannedWords(input.bannedWords, ironRules.bannedWords)))

  // 短篇字数（8000–20000，#27 第 5.2 节）
  sections.push(checkPieceWordCount(chapter._wordCount ?? countWords(body)))

  // 复读 / 句式 / 文风可量化（长短通用）
  sections.push(checkRepeat(body))
  sections.push(checkSentenceLength(body))

  sections.push(checkStyleMetrics(body, ironRules))

  // 短篇专属项（#27 第 5.3 节，吸收点 7.1）
  sections.push(checkBodyParts(body))
  sections.push(checkSimile(body))
  sections.push(checkSectionCount(body))
  sections.push(checkOpeningNoEnv(body))

  // 清单形式检（若篇目录有 清单.md，#27 第 5 节 + #28 第 3 节分工）
  // chapter._path 是正文路径，清单.md 同目录
  const pieceDir = chapter._path ? join(chapter._path, '..') : null
  let pieceList: PieceList | null = null
  if (pieceDir) {
    const manifestPath = join(pieceDir, '清单.md')
    if (existsSync(manifestPath)) {
      const r = readPieceList(manifestPath)
      if (r.ok) {
        pieceList = r.list
        sections.push(checkPieceListForm(r.list))
      }
    }
  }

  // 短篇无长程账本；清单条目作为设定收尾审的核对输入。
  const report: CheckReport = { sections, byproducts: { pieceListChecks: pieceList ? collectPieceListChecks(pieceList) : [] } }
  if (input.strictShort || input.config.short?.strict) promoteStrictShort(report)
  return report
}

const STRICT_SHORT_CHECK_IDS = new Set([
  'piece-word-short',
  'piece-word-long',
  'body-parts',
  'simile-density',
  'section-count-heading-missing',
  'section-count',
  'opening-env',
  'manifest-no-reversal',
  'manifest-setup-short',
  'manifest-payoff-open',
  'emotion-curve-short',
  'emotion-curve-strength',
  'emotion-curve-no-reversal',
  'emotion-curve-peak-low',
])

function promoteStrictShort(report: CheckReport): void {
  for (const section of report.sections) {
    for (const item of section.items) {
      if (item.level === 'yellow' && STRICT_SHORT_CHECK_IDS.has(item.checkId)) {
        item.level = 'red'
        item.message = `短篇严格模式：${item.message}`
      }
    }
  }
}

function readIronRules(bookRoot: string) {
  const ironPath = join(bookRoot, '文风', '文风铁律.md')
  return existsSync(ironPath) ? parseIronRules(readFileSync(ironPath, 'utf-8')) : {}
}

function mergeBannedWords(...lists: Array<string[] | undefined>): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []).filter(Boolean))]
}

function collectPieceListChecks(list: PieceList): NonNullable<CheckReport['byproducts']>['pieceListChecks'] {
  const checks: NonNullable<CheckReport['byproducts']>['pieceListChecks'] = []
  const core = list.反转线索表.核心反转
  for (const setup of list.反转线索表.铺垫点) {
    checks.push({
      type: 'reversal',
      subject: core || '核心反转',
      location: setup.位置,
      detail: setup.内容,
    })
  }
  for (const payoff of list.伏笔回收) {
    checks.push({
      type: 'payoff',
      subject: payoff.伏笔,
      location: payoff.回收位置,
      detail: payoff.未回收 ? '未回收' : payoff.回收位置,
    })
  }
  return checks
}
