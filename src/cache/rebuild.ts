/**
 * 重建器 —— 依据 ④ 第 5 节。
 *
 * 从 md 真源全量重建 .cache/index.db（幂等：删了能从零建回，逐字段等价）。
 *
 * 扫描顺序（④ 第 5 节）：
 * ① 大纲/{已启用类}/*.md → leads + lead_history
 * ② 定稿/正文/*.md → chapters
 * ③ 定稿/摘要/ → summaries
 * ④ 写 meta（重建戳 + 健康报告）
 *
 * 已启用类 = 基础三类（恒启用）+ book.yaml 的 leads.enabled（⑨ 第 5 节）。
 * 未启用的扩展类目录不存在即跳过，不报错（母本第 2.1 节）。
 *
 * 容错（④ 第 5 节）：单个 md 解析失败不中断重建——跳过并计入 meta 健康报告。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createAllTables, clearAllTables } from './schema.js'
import { syncLead, syncChapter, syncSummary, setMeta } from './sync.js'
import { readLeadDir } from '../format/leads.js'
import { readBookConfig } from '../format/yaml.js'
import { readChapter } from '../format/chapters.js'
import type { ParseError } from '../format/types.js'

/** 基础三类（恒启用，母本第 2.1 节） */
const BASE_LEAD_TYPES = ['伏笔', '悬念', '感情线'] as const

/** 重建结果 */
export interface RebuildResult {
  /** 入库账本数 */
  leadCount: number
  /** 入库章节数 */
  chapterCount: number
  /** 入库摘要数 */
  summaryCount: number
  /** 解析错误（健康报告） */
  errors: ParseError[]
}

/**
 * 全量重建 .cache/index.db。
 *
 * @param bookRoot 书仓库根目录（含 book.yaml、大纲/、定稿/）
 * @param cachePath .cache/index.db 路径
 */
export function rebuild(
  bookRoot: string,
  cachePath: string,
): RebuildResult {
  const errors: ParseError[] = []
  let leadCount = 0
  let chapterCount = 0
  let summaryCount = 0

  // 读 book.yaml → 决定启用哪些账本类（⑨ 第 5 节）
  const bookYamlPath = join(bookRoot, 'book.yaml')
  const cfgResult = readBookConfig(bookYamlPath)
  if (!cfgResult.ok) errors.push(cfgResult.error)
  const enabledTypes = new Set<string>(BASE_LEAD_TYPES)
  for (const t of cfgResult.config.leads.enabled) enabledTypes.add(t)

  // 确保 .cache 目录存在
  const cacheDir = dirname(cachePath)
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })

  // 建库（如果 db 文件不存在，DatabaseSync 会创建）
  const db = new DatabaseSync(cachePath)
  db.exec('BEGIN') // 原子重建
  try {
    createAllTables(db)
    clearAllTables(db) // 幂等：清空旧数据

    // ① 扫描账本（大纲/{已启用类}/）
    const outlineDir = join(bookRoot, '大纲')
    for (const typeName of enabledTypes) {
      const typeDir = join(outlineDir, typeName)
      if (!existsSync(typeDir)) continue // 未启用类目录不存在，跳过
      const { leads, errors: errs } = readLeadDir(typeDir)
      for (const lead of leads) {
        syncLead(db, lead)
        leadCount++
      }
      errors.push(...errs)
    }

    // ② 扫描章节（定稿/正文/）
    const textDir = join(bookRoot, '定稿', '正文')
    if (existsSync(textDir)) {
      const files = readdirSync(textDir).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
      for (const f of files) {
        const fp = join(textDir, f)
        if (!statSync(fp).isFile()) continue
        const r = readChapter(fp)
        if (r.ok) {
          syncChapter(db, r.chapter)
          chapterCount++
        } else {
          errors.push(r.error)
        }
      }
    }

    // ③ 扫描摘要（定稿/摘要/章摘要/ + 卷摘要/）
    const summaryBase = join(bookRoot, '定稿', '摘要')
    summaryCount += scanSummaries(db, join(summaryBase, '章摘要'), 'chapter', errors)
    summaryCount += scanSummaries(db, join(summaryBase, '卷摘要'), 'volume', errors)

    // ④ 写 meta
    setMeta(db, 'rebuilt_at', new Date().toISOString())
    setMeta(db, 'format_version', '1')
    setMeta(db, 'lead_count', String(leadCount))
    setMeta(db, 'chapter_count', String(chapterCount))
    setMeta(db, 'error_count', String(errors.length))
    if (errors.length > 0) {
      setMeta(db, 'errors', JSON.stringify(errors))
    }

    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    db.close()
    throw e
  }
  db.close()

  return { leadCount, chapterCount, summaryCount, errors }
}

/** 扫描摘要目录，文件名 <数字>.md → scope/ref/path 入库 */
function scanSummaries(
  db: DatabaseSync,
  dir: string,
  scope: 'chapter' | 'volume',
  _errors: ParseError[],
): number {
  if (!existsSync(dir)) return 0
  let count = 0
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  for (const f of files) {
    const fp = join(dir, f)
    if (!statSync(fp).isFile()) continue
    // 文件名：<章号或卷号>.md
    const ref = Number(f.replace(/\.md$/, ''))
    if (!Number.isFinite(ref)) continue
    syncSummary(db, scope, ref, fp)
    count++
  }
  return count
}
