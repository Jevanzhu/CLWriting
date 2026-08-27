/**
 * 重建器 —— 依据 #4 第 5 节。
 *
 * 从 md 真源全量重建 .cache/index.db（幂等：删了能从零建回，逐字段等价）。
 *
 * 扫描顺序（#4 第 5 节）：
 * #1 布线/{已启用类}/*.md → leads + lead_history（关系线仍在 大纲/）
 * #2 写作/正文/*.md → chapters
 * #3 定稿/摘要/ → summaries
 * #4 写 meta（重建戳 + 健康报告）
 *
 * 已启用类 = 基础两类（恒启用）+ book.yaml 的 leads.enabled（#9 第 5 节）。
 * 未启用的扩展类目录不存在即跳过，不报错（母本第 2.1 节）。
 *
 * 容错（#4 第 5 节）：单个 md 解析失败不中断重建——跳过并计入 meta 健康报告。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createAllTables, clearAllTables } from './schema.js'
import { syncLead, syncChapter, syncSummary, setMeta, getMeta } from './sync.js'
import { readLeadDir } from '../format/leads.js'
import { readBookConfig } from '../format/yaml.js'
import { readChapter } from '../format/chapters.js'
import type { ParseError } from '../format/types.js'
import { walkMdEach } from '../fs/walk-md.js'

/** 基础两类（恒启用，母本第 2.1 节） */
const BASE_LEAD_TYPES = ['悬念', '感情线'] as const

/**
 * 源树根（与全量重建扫描范围精确一致）：
 * - 目录：布线 / 写作 / 定稿 / 大纲/关系线（关系线入库但物理在 大纲/ 下）
 * - 文件：book.yaml（leads.enabled 决定扫描范围）
 * 注意：大纲/ 其余子树（章纲/卷纲/总纲）不入库——不进基准，防细纲高频编辑打穿增量。
 */
const SOURCE_SUBDIRS = ['布线', '写作', '定稿', join('大纲', '关系线')] as const

/** 源树统计：mtime 基准 + 文件数 + 总字节（X-P2-1：三者合判，删文件/改配置也能检出；
 *  R-13：min mtime 检出 mtime 倒退 + 同尺寸原位替换） */
interface SourceStats {
  maxMtime: number
  /** R-13（第十六轮）：源树最小 mtime——检出「同尺寸文件原位覆盖且 mtime 更早」的倒退改写 */
  minMtime: number
  count: number
  size: number
}

/**
 * W-P2-4 增量 rebuild 基准探测：只 stat 源目录树（不读文件内容、不解析、不入库）。
 * 比全量重建轻几个数量级（200 万字书也只做 readdir+stat）。
 * X-P2-1：max mtime 之外同时累计 count/size——纯删除不抬 max mtime，旧基准漏检删章；
 * book.yaml（非 .md）单独计入（leads.enabled 变更改变扫描范围）。
 */
function walkSourceStats(bookRoot: string): SourceStats {
  const stats: SourceStats = { maxMtime: 0, minMtime: Infinity, count: 0, size: 0 }
  const bump = (fp: string): void => {
    try {
      const st = statSync(fp)
      stats.count++
      stats.size += st.size
      if (st.mtimeMs > stats.maxMtime) stats.maxMtime = st.mtimeMs
      // R-13：同步记 min——外部工具原位覆盖常回拨 mtime（保留源时间戳），倒退即视为有变
      if (st.mtimeMs < stats.minMtime) stats.minMtime = st.mtimeMs
    } catch {
      /* stat 失败忽略 */
    }
  }
  bump(join(bookRoot, 'book.yaml'))
  // N2（五十九轮）：与 walkChapters 两套 walker 口径对齐——改走 walk-md 共享核心
  // （Dirent 不跟随 symlink + realpath 剪枝 + 根界）。原实现 Dirent 判型但无 visited
  // 无根界：SOURCE_SUBDIRS 间互指 symlink 环仍可深递归；多起遍目录共享同一 visited。
  const visited = new Set<string>()
  for (const d of SOURCE_SUBDIRS) {
    const dir = join(bookRoot, d)
    if (existsSync(dir)) walkMdEach(dir, (fp) => bump(fp), visited)
  }
  return stats
}

/**
 * W-P2-4：增量跳过检测——db 存在、meta 有基准、且源树未变
 * → 跳过全量重建，从 meta 恢复 counts/errors（语义等价：源没变 → db 内容必然没变）。
 * X-P2-1：基准为 (max mtime, 文件数, 总字节) 三元组——任一不符（含纯删除/book.yaml 变更）
 * → null（走全量重建，正好满足「删了能建回」）；旧库无新基准字段 → 首次全量。
 */
function tryIncrementalRebuild(bookRoot: string, cachePath: string): RebuildResult | null {
  if (!existsSync(cachePath)) return null
  let db: DatabaseSync
  try {
    db = new DatabaseSync(cachePath, { readOnly: true })
    // R67-8（十五轮）：只读探测也设 busy_timeout（对齐全库 5000ms 口径）——写方短暂
    // 持锁时裸读立即 SQLITE_BUSY → catch 判「打不开」走全量重建，白扔整库索引；
    // 排队等锁（毫秒级）后再读，增量跳过判定不被并发写误伤（纯性能项，不改语义）
    db.exec('PRAGMA busy_timeout = 5000')
  } catch {
    return null // 只读打不开（损坏/被锁）→ 全量重建
  }
  try {
    const recorded = getMeta(db, 'source_max_mtime')
    const recordedCount = getMeta(db, 'source_file_count')
    const recordedSize = getMeta(db, 'source_total_size')
    const recordedMin = getMeta(db, 'source_min_mtime')
    if (recorded === null || recordedCount === null || recordedSize === null || recordedMin === null) return null // 旧库无基准（含 R-13 前无 min）→ 首次全量
    const stats = walkSourceStats(bookRoot)
    if (
      stats.maxMtime > Number(recorded) ||
      stats.count !== Number(recordedCount) ||
      stats.size !== Number(recordedSize) ||
      // R-13：存在比基准更旧的文件（mtime 倒退 + 同尺寸原位替换，max/count/size 三元组全不报）
      stats.minMtime < Number(recordedMin)
    ) {
      return null // 源有变化（含删除/配置变更/mtime 倒退）→ 全量
    }
    // 无变化 → 从 meta 恢复结果
    const leadCount = Number(getMeta(db, 'lead_count') ?? '0')
    const chapterCount = Number(getMeta(db, 'chapter_count') ?? '0')
    const summaryCount = Number(getMeta(db, 'summary_count') ?? '0')
    const errCount = Number(getMeta(db, 'error_count') ?? '0')
    let errors: ParseError[] | null = errCount === 0 ? [] : null
    if (errCount > 0) {
      try {
        const parsed = JSON.parse(getMeta(db, 'errors') ?? '[]')
        if (Array.isArray(parsed)) errors = parsed as ParseError[]
      } catch {
        errors = null
      }
    }
    // R62-30：errors 元数据失联（坏 JSON/非数组/条数与 error_count 不符）不再静默当
    // 「无错」返回——那会绕过 REBUILD_FAIL 闸让坏文件红点消失；return null 走全量
    // 重建自愈（重扫重记 errors，下轮恢复增量）
    if (errors === null || errors.length !== errCount) return null
    return { leadCount, chapterCount, summaryCount, errors }
  } catch {
    return null
  } finally {
    db.close()
  }
}

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
  // W-P2-4 增量：进门/机检高频路径，源树未变则跳过全量重建（stat 级检测，语义等价）
  const incremental = tryIncrementalRebuild(bookRoot, cachePath)
  if (incremental) return incremental

  const errors: ParseError[] = []
  let leadCount = 0
  let chapterCount = 0
  let summaryCount = 0
  // W-P2-4 + X-P2-1：本次重建的源树基准（count/size 防纯删除漏检），重建后写 meta
  const sourceStats = walkSourceStats(bookRoot)
  // Q-18（第十五轮）：存精确 maxMtime——此前 ceil+1 的「缓冲」方向反了：把增量跳过的
  // 接受窗从精确 mtime 扩大到 ceil+1（同尺寸原位改写最长近 2ms 漏检）；JS number 的
  // String 往返无损，精确比较即精确接受窗（同毫秒改写是 stat 粒度固有限制，不靠缓冲解决）
  const sourceMaxMtime = sourceStats.maxMtime

  // 读 book.yaml → 决定启用哪些账本类（#9 第 5 节）
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
  try {
    // P2-5：并发 rebuild 等 5s 而非立即 SQLITE_BUSY
    // R65-22（十三轮）：PRAGMA 挪进 try 守卫——此前在 try 外，exec 抛错（库损坏/锁）
    // 时连接泄漏（RB-IF-P2-8 只盖住了 BEGIN 失败路径）
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('BEGIN') // 原子重建
  } catch (e) {
    // RB-IF-P2-8：BEGIN/PRAGMA 失败（库损坏/busy 超时耗尽）也要关连接——原先此路径泄漏 file handle + WAL
    db.close()
    throw e
  }
  try {
    createAllTables(db)
    clearAllTables(db) // 幂等：清空旧数据

    // #1 扫描账本（布线/{已启用类}/，关系线仍在 大纲/）
    for (const typeName of enabledTypes) {
      const leadRoot = typeName === '关系线' ? join(bookRoot, '大纲') : join(bookRoot, '布线')
      const typeDir = join(leadRoot, typeName)
      if (!existsSync(typeDir)) continue // 未启用类目录不存在，跳过
      const { leads, errors: errs } = readLeadDir(typeDir)
      for (const lead of leads) {
        syncLead(db, lead)
        leadCount++
      }
      errors.push(...errs)
    }

    // #2 扫描章节（写作/正文/，递归含 <卷>/ 子目录）
    // N2（五十九轮）：裸 statSync（跟随 symlink）+ 无 visited 递归改走 walk-md 共享
    // 口径（Dirent 不跟随 symlink + realpath 剪枝 + 根界）——正文区循环 symlink 不再
    // RangeError 崩 rebuild，指向书外的 symlink 章文件不再整读入库。
    const textDir = join(bookRoot, '写作', '正文')
    if (existsSync(textDir)) {
      walkMdEach(textDir, (fp) => {
        const r = readChapter(fp)
        if (r.ok) {
          syncChapter(db, r.chapter)
          chapterCount++
        } else {
          errors.push(r.error)
        }
      })
    }

    // #3 扫描摘要（定稿/摘要/章摘要/ + 卷摘要/）
    const summaryBase = join(bookRoot, '定稿', '摘要')
    summaryCount += scanSummaries(db, join(summaryBase, '章摘要'), 'chapter', errors)
    summaryCount += scanSummaries(db, join(summaryBase, '卷摘要'), 'volume', errors)

    // #4 写 meta
    setMeta(db, 'rebuilt_at', new Date().toISOString())
    setMeta(db, 'format_version', '1')
    setMeta(db, 'source_max_mtime', String(sourceMaxMtime)) // W-P2-4 增量基准
    setMeta(db, 'source_file_count', String(sourceStats.count)) // X-P2-1 删除检测
    setMeta(db, 'source_total_size', String(sourceStats.size)) // X-P2-1 删除检测
    setMeta(db, 'source_min_mtime', String(sourceStats.minMtime)) // R-13 mtime 倒退检测
    setMeta(db, 'lead_count', String(leadCount))
    setMeta(db, 'chapter_count', String(chapterCount))
    setMeta(db, 'summary_count', String(summaryCount))
    setMeta(db, 'error_count', String(errors.length))
    if (errors.length > 0) {
      setMeta(db, 'errors', JSON.stringify(errors))
    }

    db.exec('COMMIT')
  } catch (e) {
    // 内存闸（2026-08-24 审计 C4）：ROLLBACK 自身抛错（事务已自动回亡/busy）也不能跳过
    // close——finally 嵌套保证连接必关；ROLLBACK 失败吞掉、原始异常 e 原样上抛（未显式
    // 回滚的事务由 close 强制回滚兜底，语义不变）
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ROLLBACK 失败忽略：close 强制回滚未决事务 */
    } finally {
      db.close()
    }
    throw e
  }
  db.close()

  return { leadCount, chapterCount, summaryCount, errors }
}

/** 扫描摘要目录，文件名 <数字>.md → scope/ref/path 入库。
 *  R62-32：不合命名形式的 .md（如手写草稿误落摘要目录）计入 errors 进健康报告
 *  ——此前静默 continue，坏文件既不入库也无任何可见性（_errors 死参数即为此欠账）。 */
function scanSummaries(
  db: DatabaseSync,
  dir: string,
  scope: 'chapter' | 'volume',
  errors: ParseError[],
): number {
  if (!existsSync(dir)) return 0
  let count = 0
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  for (const f of files) {
    const fp = join(dir, f)
    // readdir 与 stat 之间文件可能被删（回收站/用户操作竞态）——无守卫 ENOENT 会把整个
    // rebuild 事务抛穿，单章机检与树红点聚合请求直接 500（walkChapters 同文件有守卫，此处漏）
    const st = statSync(fp, { throwIfNoEntry: false })
    if (!st || !st.isFile()) continue
    // 文件名：<章号或卷号>.md
    const ref = Number(f.replace(/\.md$/, ''))
    if (!Number.isFinite(ref)) {
      errors.push({ file: fp, line: 0, message: `摘要文件名「${f}」不是 <章号或卷号>.md 形式，未入库` })
      continue
    }
    syncSummary(db, scope, ref, fp)
    count++
  }
  return count
}
