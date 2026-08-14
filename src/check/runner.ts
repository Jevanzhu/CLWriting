/**
 * 机检总 runner —— 依据 #10 机检规则 spec。
 *
 * 聚合 #10 第 2 节全部 11 项检查（红 4 项 + 黄 7 项）→ CheckReport。
 * 红 > 0 → 自愈打回（#10 第 6 节）。
 * 顺带产出账本变动清单 / 信息差候选 / 新专名候选（#10 第 2 节末，供阶段 6 三审）。
 */

import type { DatabaseSync } from 'node:sqlite'
import { join, basename } from 'node:path'
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
  checkPieceWordCount,
  checkBodyParts,
  checkSimile,
  checkSectionCount,
  checkOpeningNoEnv,
} from './count.js'
// P2-A1：parseIronRules 下沉到 format 层（消 format→check 循环依赖）
import { parseIronRules } from '../format/iron-rules.js'
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
  /**
   * 全书最高已定稿章号（可选）。账本「凭空声称未来章」#1 检查的参照基准：
   * 默认取当前章自身章号；多章循环检查（树红点聚合）时须传全书最高值，
   * 否则高章履历规划会被单章低章号误判为「未来章」（T9b 修复）。
   */
  maxWrittenChapter?: number
}

/**
 * 跑全套机检（#10 第 2 节 11 项）→ CheckReport。
 *
 * 长短篇统一链路，按数据存在性条件开关：
 * - 有布线（账本/成长线）：账本形式三检 + 成长线 + 专名/信息差（db 强依赖）
 * - 有 config.short：短篇专属项（身体部位词/「像」/节数/开头零环境）+ 清单形式检
 * - 通用项（禁词/复读/句式/文风/字数）恒跑
 */
export function runAllChecks(input: CheckInput): CheckReport {
  const { db, bookRoot, config, chapter, body, fileName } = input
  const hasWiring = existsSync(join(bookRoot, '布线'))
  const short = config.short
  const sections: CheckSectionResult[] = []

  // 未来章基准：默认取本章自身章号；调用方传了全书最高章号时用它
  // （账本「凭空声称未来章」检查是全书视角，单章低章号会误伤高章规划，T9b 修复）。
  // 注意：这只喂 checkLeadsForm 的未来章判定；collectByproducts 必须用被检章自身章号
  // （V-P1-4：两者曾共用一个变量，三审的「本章账本变动」错拿了最高已定稿章的履历）。
  const futureBaselineChapter = input.maxWrittenChapter ?? chapter.章号
  // 已启用类 = 基础两类 + book.yaml enabled（伏笔已独立为设定伏笔系统）
  const enabledTypes = ['悬念', '感情线', ...config.leads.enabled]

  // 有布线 → 账本类检查（db 强依赖；无布线 = 独立短篇，跳过）
  if (hasWiring) {
    if (!db) {
      throw new Error('runAllChecks: 有布线（账本/成长线）机检需要 db（缓存 index.db）')
    }
    // #10 项 1 账本形式三检（红）—— 章号一致 / 引文命中 / 状态闭合 / 两端闭合
    sections.push(
      checkLeadsForm(db, bookRoot, futureBaselineChapter, enabledTypes, input.declaredLeadIds, input.actualLeadIds),
    )

    // #10 项 2 成长线语义（红）—— 仅启用成长线时
    if (config.leads.enabled.includes('成长线')) {
      const realmPath = join(bookRoot, '设定', '境界体系.md')
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
  }

  // #10 项 3 front matter 格式（红）（长短统一 ChapterMeta 口径）
  sections.push(checkFrontMatter(chapter, fileName))

  // 文风铁律（禁词红项 + 可量化黄项）
  const ironRules = readIronRules(bookRoot)

  // #10 项 4 禁词（红）
  sections.push(checkBannedWords(body, mergeBannedWords(input.bannedWords, ironRules.bannedWords)))

  // 字数（黄）：有 config.short 用短篇阈值；否则用细纲目标
  if (short) {
    sections.push(checkPieceWordCount(chapter._wordCount ?? countWords(body), short.word_min, short.word_max))
  } else {
    sections.push(checkWordCount(chapter._wordCount ?? countWords(body), input.targetWords ?? 0))
  }

  // #10 项 6 复读（黄）
  sections.push(checkRepeat(body))

  // #10 项 7 高频意象（黄）
  sections.push(checkImagery(body, input.imageryWords ?? []))

  // #10 项 8 句式体检（黄）
  sections.push(checkSentenceLength(body))

  // #10 项 9 文风可量化（黄）—— 读 文风铁律.md 的可量化硬约束阈值（#5 第 8 节）
  sections.push(checkStyleMetrics(body, ironRules))

  // 有布线 → #10 项 10 新专名候选（黄）+ #10 项 11 信息差泄密候选（黄）
  if (hasWiring) {
    const rosterPath = join(bookRoot, '设定', '名册.md')
    sections.push(checkNewNames(body, rosterPath))
    sections.push(checkInfoLeak(body, input.leakKeywords ?? []))
  }

  // 短篇专属项（#27 第 5.3 节，有 config.short 才跑）
  if (short) {
    sections.push(checkBodyParts(body, short.body_part_threshold))
    sections.push(checkSimile(body, short.simile_threshold))
    sections.push(checkSectionCount(body, short.section_count))
    sections.push(checkOpeningNoEnv(body, short.opening_env_chars))
  }

  // 清单形式检（#27 第 5 节 + #28 第 3 节分工）：章纲在 大纲/章纲/ 与正文同名，有 config.short 才跑
  let pieceList: PieceList | null = null
  if (short && chapter._path) {
    const manifestPath = join(bookRoot, '大纲', '章纲', basename(chapter._path))
    if (existsSync(manifestPath)) {
      const r = readPieceList(manifestPath)
      if (r.ok) {
        pieceList = r.list
        sections.push(checkPieceListForm(r.list))
      }
    }
  }

  let byproducts: CheckReport['byproducts'] = {}
  if (hasWiring) {
    byproducts = collectByproducts(sections, db!, chapter.章号, enabledTypes)
  }
  if (short && pieceList) {
    byproducts = { ...byproducts, pieceListChecks: collectPieceListChecks(pieceList) }
  }
  const report: CheckReport = { sections, byproducts }
  if (input.strictShort || config.short?.strict) promoteStrictShort(report)
  return report
}

/** 收集机检顺带产出（#10 第 2 节末）：本章账本变动清单 + 信息差/新专名候选。
 *  checkedChapter = 被检章自身章号（V-P1-4：三审 ledger_checks 据此核对「本章」账本变动，
 *  不得用全书最高已定稿章号）。 */
function collectByproducts(
  sections: CheckSectionResult[],
  db: DatabaseSync,
  checkedChapter: number,
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

  // 本章账本变动清单（被检章已入库的履历，按已启用类）
  const placeholders = enabledTypes.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT lh.lead_id AS leadId, lh.chapter AS chapter, lh.verb AS verb, lh.evidence AS evidence
     FROM lead_history lh JOIN leads l ON l.id = lh.lead_id
     WHERE lh.chapter = ? AND l.type IN (${placeholders})
     ORDER BY lh.lead_id`,
  ).all(checkedChapter, ...enabledTypes) as Record<string, unknown>[]
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
