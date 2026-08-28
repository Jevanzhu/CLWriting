/**
 * A1（批 1）树红点增量缓存——机检结果按章 stat 指纹缓存。
 *
 * 语义（设计 §二A1）：机检是零 token 纯函数，结果是「章内容 + 全局输入」的确定
 * 函数。缓存命中 = 与全量重算逐字节等价；两层指纹保证这一点：
 *
 * 1. 章级指纹（tree_issues_cache 行键）：正文 (mtime, size) + 裁决信封
 *    项目/分析/<docId>.json 的 "mtime:size"（verdict 驳回写信封 → mtime 变 →
 *    自动失效，无需专门通知）。mtime+size 撞车理论窗口与树 probeCache 同口径。
 * 2. 全局纪元（tree_issues_meta.global_fp）：机检还吃章外全局输入——book.yaml /
 *    global.json（配置与托底）、布线（账本 db 源）、大纲/章纲（targetWords）、
 *    工作区/细纲.md（账本推进声明）、设定/境界体系.md（成长线）、文风/、
 *    工作区/账本推进.md + 工作区/.账本推进暂存/（R65-24 两源读取，R66-3 入纪元）、
 *    项目/文档清单.jsonl（maxWritten 基准 + final 跳过）。
 *    任一 stat 变化 → 整表清空重查（改配置/定稿/动账本是低频操作，可接受连坐）。
 *    章正文本身不在纪元里——改 1 章只破那 1 章的行指纹，这正是增量的意义。
 *
 * 回退（红线）：表缺席 / 读写失败 → 抛出由调用方吞掉、跳过缓存走现行全量路径
 * （语义无损降级，只有性能回到从前）。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureTreeIssuesTables } from '../cache/schema.js'
import { LEAD_UPDATES_ARCHIVE_DIR } from './lead-updates.js'

/** 机检器代次：词表 / 阈值 / 规则语义演进时 bump（旧缓存整代表失效）。
 *  a1-v2（2026-08-21 H-1）：章级行不再含账本全书性条目（改独立缓存 leads_book_*），
 *  旧代行语义不同（hasRed 含跨章红项），整代失效防新旧混存。 */
const CHECKER_GENERATION = 'a1-v2'

export interface TreeIssueEntry {
  hasRed: boolean
  verdictRejected: boolean
}

/** 文件指纹 "mtime:size"；不存在 → 'absent'（新出现/消失都构成变化）。
 *  R73-27（二十一轮）：精度从 mtimeMs 升级 mtimeNs（bigint stat）——与章元数据缓存
 *  （chapters.ts CC-P1-3，R62-35 同款）统一到 ns 级：同毫秒内「改回同长内容」此前
 *  不失效（纪元指纹粒度与章缓存不一致），ns 级撞车窗口收窄到与章缓存同源口径。
 *  指纹串格式随升级变化 → 旧 global_fp 比对必 miss，一次性整表重查（语义无损）。 */
function fileFp(p: string): string {
  try {
    const st = statSync(p, { bigint: true })
    return `${st.mtimeNs}:${st.size}`
  } catch {
    return 'absent'
  }
}

/** 目录树指纹 "count:size:maxMtime:nameHash"（递归文件，跳过 ._ 资源文件）。
 *  nameHash = 相对路径 FNV-1a（2026-08-21 四轮复审）：纯改名 count/size/mtime 全不变，
 *  但章节文件名是 findChapterFile 章号映射与引文 grep 的输入——改名不失效会让
 *  leads_book 缓存陈旧（含本指纹的纪元 dirFp 同享此修正，一次性整表失效无害）。
 *  R73-27（二十一轮）：maxMtime 同步升 mtimeNs（同 fileFp 口径）。 */
function dirFp(p: string): string {
  if (!existsSync(p)) return 'absent'
  let count = 0
  let size = 0
  let maxMtime = 0n
  let nameHash = 0x811c9dc5
  const walk = (dir: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('._') || e.name === '.DS_Store') continue
      const fp = join(dir, e.name)
      if (e.isDirectory()) walk(fp, `${prefix}${e.name}/`)
      else if (e.isFile()) {
        try {
          const st = statSync(fp, { bigint: true })
          count++
          size += Number(st.size)
          if (st.mtimeNs > maxMtime) maxMtime = st.mtimeNs
          const rel = `${prefix}${e.name}`
          for (let i = 0; i < rel.length; i++) {
            nameHash ^= rel.charCodeAt(i)
            nameHash = Math.imul(nameHash, 0x01000193) >>> 0
          }
        } catch {
          /* 竞态消失：跳过 */
        }
      }
    }
  }
  walk(p, '')
  return `${count}:${size}:${maxMtime}:${nameHash.toString(16)}`
}

/**
 * 全局纪元指纹：全部「章外输入」的 stat 摘要。userDataPath 传入时含 global.json
 * （applyGlobalDefaults 托底值影响 short.strict 等）。文风/ 含铁律与条目库禁词
 * （readIronRules 合并源）；大纲/章纲 含 targetWords；清单含 maxWritten 基准。
 * 细纲.md 是 declaredLeadIds 的来源（两端闭合左侧）、设定/境界体系.md 是成长线
 * 红项输入（growth-realm-*）、设定/名册.md 是新专名候选输入（R65-17）——此前三者
 * 漏在纪元外（名册为十三轮补），编辑后树红点/黄项不失效可陈旧。
 */
export function computeTreeIssuesGlobalFp(bookRoot: string, userDataPath: string | null): string {
  const parts = [
    CHECKER_GENERATION,
    fileFp(join(bookRoot, 'book.yaml')),
    userDataPath ? fileFp(join(userDataPath, 'global.json')) : 'no-userdata',
    dirFp(join(bookRoot, '布线')),
    dirFp(join(bookRoot, '大纲', '关系线')),
    dirFp(join(bookRoot, '大纲', '章纲')),
    dirFp(join(bookRoot, '文风')),
    fileFp(join(bookRoot, '工作区', '细纲.md')),
    fileFp(join(bookRoot, '设定', '境界体系.md')),
    // R65-17（十三轮）：checkNewNames 的名册输入入纪元——此前漏掉，作者改名册后
    // 章级缓存不失效，新专名候选黄项陈旧（登记表新名被误报/漏报）
    fileFp(join(bookRoot, '设定', '名册.md')),
    fileFp(join(bookRoot, '工作区', '账本推进.md')),
    // R66-3（十四轮）：R65-24 起机检吃「主文件 + .账本推进暂存 归档」两源，但纪元只含
    // 主文件 fileFp——归档章被补/改/删而纪元内文件不动时，章级缓存命中陈旧行（假红
    // 残留/漏红）。归档目录 dirFp 入纪元一次性整表失效（对齐周边目录口径，无害）。
    dirFp(join(bookRoot, LEAD_UPDATES_ARCHIVE_DIR)),
    fileFp(join(bookRoot, '项目', '文档清单.jsonl')),
  ]
  return parts.join('|')
}

/**
 * H-1（2026-08-21）：账本全书性红项（章号一致/引文命中/状态闭合）的缓存指纹。
 * 这些条目 = 布线 db（纪元已含）× **任意章正文**（引文 grep 按履历章号直读），所以
 * 指纹 = 纪元 + 写作/正文 目录 stat 摘要——改任何一章正文都会失效重算（正确性所需，
 * 与章级行的增量性互不拖累：章级行只含章作用域检查）。存 tree_issues_meta 两个键：
 * leads_book_fp / leads_book_red，无需 DDL 变更。
 */
export function computeLeadsBookFp(bookRoot: string, userDataPath: string | null): string {
  return `${computeTreeIssuesGlobalFp(bookRoot, userDataPath)}|${dirFp(join(bookRoot, '写作', '正文'))}`
}

/** 全书性红项缓存读：指纹全中才命中，否则 null（调用方重算）。
 *  R65-21（十三轮）：两键合并单条 SELECT（key IN 两值一次取回）——原两条独立 SELECT
 *  无事务包裹，跨进程写方（writeLeadsBookRed 同事务提交瞬间）可读到撕裂 fp/red 对
 *  （新 fp 配旧 red）。单条语句自带隐式读事务，两行必同快照；不选显式
 *  BEGIN DEFERRED…COMMIT 方案：读侧多持锁徒增 busy 风险，单语句零成本达成同一致性。 */
export function readLeadsBookRed(db: DatabaseSync, fp: string): boolean | null {
  try {
    const rows = db
      .prepare(`SELECT key, value FROM tree_issues_meta WHERE key IN ('leads_book_fp', 'leads_book_red')`)
      .all() as Array<{ key: string; value: string }>
    let fpRow: string | undefined
    let redRow: string | undefined
    for (const r of rows) {
      if (r.key === 'leads_book_fp') fpRow = r.value
      else if (r.key === 'leads_book_red') redRow = r.value
    }
    if (fpRow !== fp) return null
    return redRow === '1' ? true : redRow === '0' ? false : null
  } catch {
    return null // 表异常/损坏：视为 miss 走重算（自愈）
  }
}

/** 全书性红项缓存写（两键同事务；失败静默——缓存只是加速）。 */
export function writeLeadsBookRed(db: DatabaseSync, fp: string, hasRed: boolean): void {
  try {
    db.exec('BEGIN')
    try {
      db.prepare('INSERT OR REPLACE INTO tree_issues_meta (key, value) VALUES (?, ?)').run('leads_book_fp', fp)
      db.prepare('INSERT OR REPLACE INTO tree_issues_meta (key, value) VALUES (?, ?)').run('leads_book_red', hasRed ? '1' : '0')
      db.exec('COMMIT')
    } catch (e) {
      // R64-7（十二轮）：R61-10 同款——裸 ROLLBACK 在事务已自动回亡时抛
      // "no transaction is active"，次要异常会替代原始病因上抛（吞诊断）
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 已自动回亡：原始错误优先 */
      }
      throw e
    }
  } catch {
    /* 写失败（锁/磁盘）：下轮 miss 重算 */
  }
}

/**
 * 纪元对齐：全局指纹变化（或首次）→ 清空缓存表并记录新纪元；返回 true 表示
 * 本次已清（调用方可用于诊断计数）。表结构缺失时补建（幂等）。
 */
export function syncTreeIssuesEpoch(db: DatabaseSync, bookRoot: string, userDataPath: string | null): boolean {
  ensureTreeIssuesTables(db)
  const fp = computeTreeIssuesGlobalFp(bookRoot, userDataPath)
  const row = db.prepare('SELECT value FROM tree_issues_meta WHERE key = ?').get('global_fp') as
    | { value: string }
    | undefined
  if (row?.value === fp) return false
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM tree_issues_cache')
    db.prepare('INSERT OR REPLACE INTO tree_issues_meta (key, value) VALUES (?, ?)').run('global_fp', fp)
    db.exec('COMMIT')
  } catch (e) {
    // R64-7（十二轮）：R61-10 同款——吞 ROLLBACK 自身异常，原样上抛原始错误
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 已自动回亡：原始错误优先 */
    }
    throw e
  }
  return true
}

/** 章级缓存读：三元组 + verdict 指纹全中才命中（NULL 信封按 IS NULL 匹配）。 */
export function readTreeIssuesCache(
  db: DatabaseSync,
  relPath: string,
  mtimeMs: number,
  size: number,
  verdictFp: string | null,
): TreeIssueEntry | null {
  try {
    const row = (
      verdictFp === null
        ? db
            .prepare(
              'SELECT report_json FROM tree_issues_cache WHERE rel_path = ? AND mtime_ms = ? AND size = ? AND verdict_fp IS NULL',
            )
            .get(relPath, mtimeMs, size)
        : db
            .prepare(
              'SELECT report_json FROM tree_issues_cache WHERE rel_path = ? AND mtime_ms = ? AND size = ? AND verdict_fp = ?',
            )
            .get(relPath, mtimeMs, size, verdictFp)
    ) as { report_json: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.report_json) as TreeIssueEntry
    return typeof parsed.hasRed === 'boolean' && typeof parsed.verdictRejected === 'boolean' ? parsed : null
  } catch {
    return null // 损坏行/表异常：视为 miss，走重算回写（自愈）
  }
}

/** 章级缓存写（INSERT OR REPLACE：同章新指纹覆盖旧行，不留废行）。 */
export function writeTreeIssuesCache(
  db: DatabaseSync,
  relPath: string,
  mtimeMs: number,
  size: number,
  verdictFp: string | null,
  entry: TreeIssueEntry,
): void {
  try {
    db.prepare(
      'INSERT OR REPLACE INTO tree_issues_cache (rel_path, mtime_ms, size, verdict_fp, report_json) VALUES (?, ?, ?, ?, ?)',
    ).run(relPath, mtimeMs, size, verdictFp, JSON.stringify(entry))
  } catch {
    /* 写失败（锁/磁盘）：缓存只是加速，静默放弃本行（下次 miss 重算） */
  }
}

/**
 * 结构性变更整表清空（invalidateTreeIndex(structural=true) 调用）：
 * 改名/移动/删章后旧行成垃圾（键是 rel_path，残留不致错——新路径必 miss——
 * 只会膨胀），整表清掉回收。index.db 不存在（短篇无布线书）→ no-op。
 * best-effort：清失败不影响主流程（残留行无害）。
 */
export function clearTreeIssuesCacheForBook(bookRoot: string): void {
  const cachePath = join(bookRoot, '.cache', 'index.db')
  if (!existsSync(cachePath)) return
  let db: DatabaseSync
  try {
    db = new DatabaseSync(cachePath)
  } catch {
    return // 库损坏/被锁：清不掉就留着（残留行无害）
  }
  try {
    db.exec('PRAGMA busy_timeout = 1000')
    ensureTreeIssuesTables(db)
    db.exec('DELETE FROM tree_issues_cache')
  } catch {
    /* best-effort */
  } finally {
    db.close()
  }
}
