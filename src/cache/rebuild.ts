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
import { log } from '../log/index.js'

/** 基础两类（恒启用，母本第 2.1 节） */
const BASE_LEAD_TYPES = ['悬念', '感情线'] as const

// ── R37-16（三十七轮）：章读 mtime+size 指纹缓存 ──────────────────────────
// walkMdEach 遍历 textDir 对每章 readChapter 全量同步读（readFile + parseFlat +
// countWords 全正文扫）——大书（≥500 章）全量重建时秒级阻塞事件循环，而绝大多数
// 章自上次重建后未变。缓存挂**模块级**（跨 rebuild 调用共享才有收益；每次调用新建
// Map 则永远 miss）。键=章文件绝对路径，值={指纹（mtimeMs/size/ino）, 解析结果}：
// - stat 必须先于 read：stat→read 之间文件再变 → 缓存键记的是旧 mtime，下次 rebuild
//   判 miss 重读自愈；反向（read→stat）会把新 mtime 配旧内容，脏缓存存活到下次变更
//   ——故序不可换。
// - 指纹 = mtimeMs + size + ino 三元组（实测 Node v25.9 运行时 Stats 亦无 mtimeNs
//   字段、@types/node 24 同缺，不可用；mtimeMs 是 double，APFS 纳秒 / NTFS 100ns
//   精度经 stat 落入小数毫秒位（如 …975.7954），子毫秒改写可区分；ino 防「同
//   mtime 同尺寸原位替换」——新文件新 inode，三者全符才命中（口径对齐 search.ts
//   R35-7 dirSignature 的「mtime 探针换免整书重扫」手法，粒度细化到单章；
//   win 下 ino 恒 0 时退化为 mtimeMs+size 双条件，精度仍够）。
// - parsed 结果对象跨 rebuild 复用：syncChapter 只读不写 chapter（sync.ts 已核），
//   复用安全；错误分支同样缓存（坏文件未变时健康报告逐次等价）。
// - 容量 2048 条（按「≥500 章大书」的 4 倍余量），超限逐出最旧（Map 插入序 FIFO：
//   命中不重插不刷新位置，非严格 LRU——rebuild 是低频全量扫描、键集稳定，FIFO 零
//   记账已够用；不选「超限整清」是避免一本大书反复触顶后每次 rebuild 全量 miss）。
const CHAPTER_CACHE_MAX = 2048

/** readChapter 结果（ok/错误两分支统一缓存）。 */
type ChapterParseResult = ReturnType<typeof readChapter>

/** 生效容量（测试可注入缩小；生产恒用 CHAPTER_CACHE_MAX）。 */
let chapterCacheMax = CHAPTER_CACHE_MAX

/** 模块级章读缓存（见上方块注释）。 */
const chapterCache = new Map<
  string,
  { mtimeMs: number; size: number; ino: number; parsed: ChapterParseResult }
>()

/** 命中/未命中计数（测试断言用；生产只增不读）。 */
const chapterCacheStats = { hits: 0, misses: 0 }

/** R37-16：带指纹缓存的章读——命中复用上次解析结果，未命中 readChapter 后入缓存。 */
function readChapterCached(fp: string): ChapterParseResult {
  // stat 失败（readdir 与读之间被删的竞态）→ 绕过缓存直读，走 readChapter 既有错误契约
  const st = statSync(fp, { throwIfNoEntry: false })
  if (!st) return readChapter(fp)
  const hit = chapterCache.get(fp)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) {
    chapterCacheStats.hits++
    return hit.parsed
  }
  const parsed = readChapter(fp)
  chapterCache.set(fp, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, parsed })
  chapterCacheStats.misses++
  while (chapterCache.size > chapterCacheMax) {
    const oldest = chapterCache.keys().next().value
    if (oldest === undefined) break
    chapterCache.delete(oldest)
  }
  return parsed
}

/** R37-16：测试钩子（生产零调用；先例同 search.ts __resetSearchScanCountForTest /
 *  web-next client.ts __testHooks）——清空章读缓存与计数，防测试间污染（模块级
 *  缓存跨用例存活，同一绝对路径的命中会吃上一用例的指纹）。 */
export const __testHooks = {
  clearChapterCache(): void {
    chapterCache.clear()
    chapterCacheStats.hits = 0
    chapterCacheStats.misses = 0
  },
  chapterCacheStats(): { hits: number; misses: number; entries: number } {
    return { ...chapterCacheStats, entries: chapterCache.size }
  },
  /** 容量注入（null 还原默认；测淘汰用）。 */
  setChapterCacheMaxForTest(n: number | null): void {
    chapterCacheMax = n ?? CHAPTER_CACHE_MAX
  },
}

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
        // R37-16：章读接指纹缓存——正文未变的章命中后不再整读 + countWords（大书全量
        // 重建的秒级事件循环阻塞大头），已变章（mtime/size/ino 任一不符）重读并刷新缓存
        const r = readChapterCached(fp)
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
    // R71-37（总七十一轮）：Number() 过宽——`.md`→0、`0x10.md`→16、`1e2.md`→100、
    // `-3.md`→-3 均 Number.isFinite 入表且不进健康报告；改 /^\d+$/ 严格白名单
    // （不匹配 → errors.push 计入健康报告，对齐同函数 R62-32 口径）
    // R73-47（二十一轮）：白名单外命名追加 log.warn 留痕——errors 只进 meta 健康报告
    // （下次增量跳过重建时不可见），操作日志即时留痕方便定位「摘要不生效」类问题；
    // 命名契约本身不动（<数字>.md 仍是唯一入库形态）。
    if (!/^\d+$/.test(f.replace(/\.md$/, ''))) {
      log.warn('rebuild', `摘要文件名「${f}」不是 <章号或卷号>.md 形式，未入库（${dir}）`)
      errors.push({ file: fp, line: 0, message: `摘要文件名「${f}」不是 <章号或卷号>.md 形式，未入库` })
      continue
    }
    const ref = Number(f.replace(/\.md$/, ''))
    syncSummary(db, scope, ref, fp)
    count++
  }
  return count
}
