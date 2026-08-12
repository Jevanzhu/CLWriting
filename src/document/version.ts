/**
 * 版本档案 version —— 统一编辑快照 + 定稿版本（去 git 版本系统）。
 *
 * 由 snapshot.ts 泛化而来：同一套「全文 + front matter 元信息」机制，
 * origin 区分来源（autosave 编辑快照 / finalize 定稿版本 / restore 恢复留底…）。
 *
 * 落点：工作区/.版本/<docId>/<ULID>.md（原 .snapshots 改名 .版本，首次启动自动迁移）。
 * id 即 ULID，含时间戳可排序。用 atomicWriteFile 整文件写（版本是独立文件，非追加日志）。
 *
 * pinned（永久保留）：finalize 写的定稿版本 pinned=true，prune 清理**跳过**——
 * 定稿里程碑不因分层保留/数量兜底被删，文章历史永久可回溯。
 *
 * 密度控制三件套（全文副本不做 diff 链——省下的空间换不来"恢复要重放、链断全废、
 * 文件不再是能直接打开的 markdown"）：
 * 1. 去重：与最新版本同内容 → 不落新文件
 * 2. 节流：同一文档窗口内只留一个（force 时跳过，如删除/改名前留底）
 * 3. 分层保留：写入后顺带 prune，越近越细越远越粗（pinned 跳过）
 */
import { existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { safeDocId } from '../fs/safe-path.js'
import { ulid, decodeUlidTime } from './stable-id.js'
import { readFile, parseFlat } from '../format/frontmatter.js'
import type { Revision } from './revision.js'

/** 版本目录名（工作区/ 下，treeskip + 迁移用）。 */
export const VERSIONS_DIR_NAME = '.版本'
/** 旧快照目录名（迁移源）。 */
export const LEGACY_SNAPSHOTS_DIR_NAME = '.snapshots'

export interface VersionMeta {
  /** 来源：autosave 编辑快照 / manual 手动留底 / finalize 定稿 / restore 恢复 / rename / delete… */
  origin: string
  reason?: string
  baseRevision?: Revision
  /** 正文字数（剥 front matter 后）。 */
  words?: number
  /** 永久保留（finalize 定稿版本）；prune 不清理。 */
  pinned?: boolean
}

export interface VersionInfo {
  id: string
  path: string
}

/** 版本列表项（对外，含解出的时间与元信息）。 */
export interface VersionEntry {
  id: string
  /** 毫秒时间戳（ULID 解出）。 */
  time: number
  origin: string
  reason: string
  /** 正文字数（剥 front matter 后）。 */
  words: number
  /** 永久保留标记（finalize 定稿版本）。 */
  pinned: boolean
}

/** 保留策略。maxDays/maxCount 由 book.yaml 配置，throttleMinutes 为内部规则。 */
export interface VersionPolicy {
  /** 超期删除（天）。 */
  maxDays: number
  /** 每文档保留上限（个）。 */
  maxCount: number
  /** 写入节流（分钟）：窗口内已有版本则跳过。 */
  throttleMinutes: number
}

export const DEFAULT_VERSION_POLICY: VersionPolicy = {
  maxDays: 14,
  maxCount: 30,
  throttleMinutes: 5,
}

export interface WriteVersionOptions {
  policy?: VersionPolicy
  /** 跳过节流：删除/改名前留底、restore 覆盖前留底等"必须留"的时刻。 */
  force?: boolean
}

const HOUR_MS = 3600_000
const DAY_MS = 86_400_000
/** 最近 2 小时的版本全留（细粒度回退窗口）。 */
const FINE_WINDOW_MS = 2 * HOUR_MS

/**
 * 建版本：全文 + front matter 元信息（来源/原因/基线/字数/永久）。
 * 返回版本 id；被去重或节流跳过时返回 null。写入成功后顺带 prune（不引定时器）。
 */
export function writeVersion(
  versionsDir: string,
  docId: string,
  content: string,
  meta: VersionMeta,
  options: WriteVersionOptions = {},
): string | null {
  const policy = options.policy ?? DEFAULT_VERSION_POLICY
  // 默认 force=true（兼容旧快照调用方行为——编辑器保存每次都留底；需节流的调用方显式传 force:false）
  const force = options.force ?? true
  const existing = listVersions(versionsDir, docId)
  const latest = existing[0]

  if (latest) {
    // 节流：窗口内已有版本 → 跳过（force 时不限）
    if (!force && policy.throttleMinutes > 0) {
      const age = Date.now() - decodeUlidTime(latest.id)
      if (age < policy.throttleMinutes * 60_000) return null
    }
    // 去重：与最新版本同内容 → 不落新文件
    const prev = readVersion(versionsDir, docId, latest.id)
    if (prev && prev.content === content) return null
  }

  const id = ulid()
  const ts = new Date().toISOString()
  const front: string[] = ['---', `版本ID: ${id}`, `时间: ${ts}`, `来源: ${meta.origin}`]
  if (meta.reason) front.push(`原因: ${meta.reason}`)
  if (meta.baseRevision) front.push(`基线: ${meta.baseRevision}`)
  if (meta.words !== undefined) front.push(`字数: ${meta.words}`)
  if (meta.pinned) front.push('永久: true')
  front.push('---', '')
  const file = join(versionsDir, docId, `${id}.md`)
  atomicWriteFile(file, front.join('\n') + content, { fsync: true })
  pruneVersions(versionsDir, docId, policy)
  return id
}

/** 列某文档的版本（按 id 降序，新的在前；id 是 ULID 时间排序）。 */
export function listVersions(versionsDir: string, docId: string): VersionInfo[] {
  if (!safeDocId(docId)) return []
  const dir = join(versionsDir, docId)
  if (!existsSync(dir)) return []
  const out: VersionInfo[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._') || !name.endsWith('.md')) continue
    out.push({ id: name.slice(0, -3), path: join(dir, name) })
  }
  return out.sort((a, b) => b.id.localeCompare(a.id))
}

/** 读单个版本：剥 front matter → 内容 + 元信息。文件缺失/损坏返回 null。 */
export function readVersion(
  versionsDir: string,
  docId: string,
  id: string,
): { content: string; meta: VersionMeta & { time: number } } | null {
  // id 防穿越：ULID 是 26 位 Crockford base32，不含分隔符
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null
  // docId 防穿越（manifest 可篡改数据面 defense-in-depth）
  if (!safeDocId(docId)) return null
  const file = join(versionsDir, docId, `${id}.md`)
  if (!existsSync(file)) return null
  const r = readFile(file)
  if (!r.ok) return null
  const map = parseFlat(r.fmRaw)
  const meta: VersionMeta & { time: number } = {
    origin: String(map.get('来源') ?? ''),
    time: decodeUlidTime(id),
  }
  const reason = map.get('原因')
  if (reason) meta.reason = String(reason)
  const base = map.get('基线')
  if (base) meta.baseRevision = String(base) as Revision
  const words = map.get('字数')
  if (typeof words === 'number' && words > 0) meta.words = words
  const pinnedRaw = map.get('永久')
  if (pinnedRaw === true || pinnedRaw === 'true') meta.pinned = true
  return { content: r.body, meta }
}

/** 列版本（对外：含时间/来源/原因/字数/永久，供 UI 展示）。 */
export function listVersionEntries(
  versionsDir: string,
  docId: string,
  countWords: (text: string) => number,
): VersionEntry[] {
  const out: VersionEntry[] = []
  for (const s of listVersions(versionsDir, docId)) {
    const read = readVersion(versionsDir, docId, s.id)
    if (!read) continue
    out.push({
      id: s.id,
      time: read.meta.time,
      origin: read.meta.origin,
      reason: read.meta.reason ?? '',
      words: read.meta.words ?? countWords(read.content),
      pinned: read.meta.pinned ?? false,
    })
  }
  return out
}

/**
 * 分层保留清理（Time Machine 式）：越近越细，越远越粗，匹配真实需求分布——
 * 刚写的想细粒度退，几天前只需一个锚点。pinned（定稿里程碑）恒保留。
 *
 * | 最近 2 小时      | 全留               |
 * | 2 - 24 小时      | 每小时 1 个（取最早）|
 * | 1 天 - maxDays   | 每天 1 个（取最早）  |
 * | 超过 maxDays     | 删（pinned 仍留）   |
 * | 总数超 maxCount  | 从最旧删（pinned 不删）|
 *
 * @returns 删除的版本数
 */
export function pruneVersions(
  versionsDir: string,
  docId: string,
  policy: VersionPolicy = DEFAULT_VERSION_POLICY,
  now: number = Date.now(),
): number {
  const all = listVersions(versionsDir, docId)
  if (!all.length) return 0

  // 升序（旧→新）遍历，每个时间桶的第一个即该桶最早的
  const ascending = [...all].reverse()
  const keep = new Set<string>()
  const pinned = new Set<string>()
  const hourBuckets = new Set<number>()
  const dayBuckets = new Set<number>()
  const maxAge = policy.maxDays * DAY_MS

  for (const s of ascending) {
    const read = readVersion(versionsDir, docId, s.id)
    if (read?.meta.pinned) {
      // 定稿版本永久保留：不参与分层/超期清理
      keep.add(s.id)
      pinned.add(s.id)
      continue
    }
    const t = decodeUlidTime(s.id)
    const age = now - t
    if (age > maxAge) continue // 超期不留
    if (age <= FINE_WINDOW_MS) {
      keep.add(s.id)
    } else if (age <= DAY_MS) {
      const bucket = Math.floor(t / HOUR_MS)
      if (!hourBuckets.has(bucket)) {
        hourBuckets.add(bucket)
        keep.add(s.id)
      }
    } else {
      const bucket = Math.floor(t / DAY_MS)
      if (!dayBuckets.has(bucket)) {
        dayBuckets.add(bucket)
        keep.add(s.id)
      }
    }
  }

  // 数量兜底：留最新的 maxCount 个；pinned 恒在（all 已按 id 降序 = 新在前）
  if (keep.size > policy.maxCount) {
    const survivors = all.filter((s) => keep.has(s.id) && !pinned.has(s.id)).slice(0, policy.maxCount - pinned.size)
    keep.clear()
    for (const s of pinned) keep.add(s)
    for (const s of survivors) keep.add(s.id)
  }

  let removed = 0
  for (const s of all) {
    if (keep.has(s.id)) continue
    try {
      unlinkSync(s.path)
      removed++
    } catch {
      continue // 已被别处删掉无妨
    }
    // macOS AppleDouble 伴生文件一并清理
    try {
      unlinkSync(join(versionsDir, docId, `._${s.id}.md`))
    } catch {
      /* 没有就算了 */
    }
  }
  return removed
}

/**
 * 目录迁移：`工作区/.snapshots/` → `工作区/.版本/`（幂等）。
 * 旧快照默认 pinned=false（除非 front matter 已带 永久 字段）。
 * - 源不存在 → no-op
 * - 目标已存在 → 跳过（防覆盖）
 *
 * @returns 是否执行了迁移
 */
export function migrateVersionsDir(bookRoot: string): boolean {
  const legacy = join(bookRoot, '工作区', LEGACY_SNAPSHOTS_DIR_NAME)
  const target = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
  if (!existsSync(legacy)) return false
  if (existsSync(target)) return false
  try {
    renameSync(legacy, target)
    return true
  } catch {
    return false // 迁移失败（权限/占用）→ 保留旧目录，读取方仍兼容
  }
}