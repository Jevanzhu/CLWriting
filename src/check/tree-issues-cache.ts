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
 *    工作区/账本推进.md、项目/文档清单.jsonl（maxWritten 基准 + final 跳过）。
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

/** 机检器代次：词表 / 阈值 / 规则语义演进时 bump（旧缓存整代表失效）。 */
const CHECKER_GENERATION = 'a1-v1'

export interface TreeIssueEntry {
  hasRed: boolean
  verdictRejected: boolean
}

/** 文件指纹 "mtime:size"；不存在 → 'absent'（新出现/消失都构成变化）。 */
function fileFp(p: string): string {
  try {
    const st = statSync(p)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'absent'
  }
}

/** 目录树指纹 "count:size:maxMtime"（递归文件，跳过 ._ 资源文件）。 */
function dirFp(p: string): string {
  if (!existsSync(p)) return 'absent'
  let count = 0
  let size = 0
  let maxMtime = 0
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('._') || e.name === '.DS_Store') continue
      const fp = join(dir, e.name)
      if (e.isDirectory()) walk(fp)
      else if (e.isFile()) {
        try {
          const st = statSync(fp)
          count++
          size += st.size
          if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs
        } catch {
          /* 竞态消失：跳过 */
        }
      }
    }
  }
  walk(p)
  return `${count}:${size}:${maxMtime}`
}

/**
 * 全局纪元指纹：全部「章外输入」的 stat 摘要。userDataPath 传入时含 global.json
 * （applyGlobalDefaults 托底值影响 short.strict 等）。文风/ 含铁律与条目库禁词
 * （readIronRules 合并源）；大纲/章纲 含 targetWords；清单含 maxWritten 基准。
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
    fileFp(join(bookRoot, '工作区', '账本推进.md')),
    fileFp(join(bookRoot, '项目', '文档清单.jsonl')),
  ]
  return parts.join('|')
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
    db.exec('ROLLBACK')
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
