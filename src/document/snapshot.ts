/**
 * 快照 snapshot（W0-1 §7）—— 全文 + 元信息，用于冲突覆盖前/定稿章首改前等恢复点。
 *
 * 落点：工作区/.snapshots/<docId>/<ULID>.md（gitignore）。id 即 ULID，含时间戳可排序。
 * 用 atomicWriteFile 整文件写（快照是独立文件，非追加日志）。
 *
 * 密度控制三件套（全文副本不做 diff 链——省下的空间换不来"恢复要重放、链断全废、
 * 文件不再是能直接打开的 markdown"）：
 * 1. 去重：与最新快照同内容 → 不落新文件
 * 2. 节流：同一文档窗口内只留一个（force 时跳过，如删除/改名前留底）
 * 3. 分层保留：写入后顺带 prune，越近越细越远越粗
 */
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { ulid, decodeUlidTime } from './stable-id.js'
import { readFile, parseFlat } from '../format/frontmatter.js'
import type { Revision } from './revision.js'

export interface SnapshotMeta {
  origin: string
  reason?: string
  baseRevision?: Revision
}

export interface SnapshotInfo {
  id: string
  path: string
}

/** 快照列表项（对外，含解出的时间与元信息）。 */
export interface SnapshotEntry {
  id: string
  /** 毫秒时间戳（ULID 解出）。 */
  time: number
  origin: string
  reason: string
  /** 正文字数（剥 front matter 后）。 */
  words: number
}

/** 保留策略。maxDays/maxCount 由 book.yaml 配置，throttleMinutes 为内部规则。 */
export interface SnapshotPolicy {
  /** 超期删除（天）。 */
  maxDays: number
  /** 每文档保留上限（个）。 */
  maxCount: number
  /** 写入节流（分钟）：窗口内已有快照则跳过。 */
  throttleMinutes: number
}

export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = {
  maxDays: 14,
  maxCount: 30,
  throttleMinutes: 5,
}

export interface WriteSnapshotOptions {
  policy?: SnapshotPolicy
  /** 跳过节流：删除/改名前留底、restore 覆盖前留底等"必须留"的时刻。 */
  force?: boolean
}

const HOUR_MS = 3600_000
const DAY_MS = 86_400_000
/** 最近 2 小时的快照全留（细粒度回退窗口）。 */
const FINE_WINDOW_MS = 2 * HOUR_MS

/**
 * 建快照：全文 + front matter 元信息（origin/reason/baseRevision）。
 * 返回快照 id；被去重或节流跳过时返回 null。写入成功后顺带 prune（不引定时器）。
 */
export function writeSnapshot(
  snapshotsDir: string,
  docId: string,
  content: string,
  meta: SnapshotMeta,
  options: WriteSnapshotOptions = {},
): string | null {
  const policy = options.policy ?? DEFAULT_SNAPSHOT_POLICY
  const force = options.force ?? true
  const existing = listSnapshots(snapshotsDir, docId)
  const latest = existing[0]

  if (latest) {
    // 节流：窗口内已有快照 → 跳过（force 时不限）
    if (!force && policy.throttleMinutes > 0) {
      const age = Date.now() - decodeUlidTime(latest.id)
      if (age < policy.throttleMinutes * 60_000) return null
    }
    // 去重：与最新快照同内容 → 不落新文件
    const prev = readSnapshot(snapshotsDir, docId, latest.id)
    if (prev && prev.content === content) return null
  }

  const id = ulid()
  const ts = new Date().toISOString()
  const front: string[] = ['---', `快照ID: ${id}`, `时间: ${ts}`, `来源: ${meta.origin}`]
  if (meta.reason) front.push(`原因: ${meta.reason}`)
  if (meta.baseRevision) front.push(`基线: ${meta.baseRevision}`)
  front.push('---', '')
  const file = join(snapshotsDir, docId, `${id}.md`)
  atomicWriteFile(file, front.join('\n') + content)
  pruneSnapshots(snapshotsDir, docId, policy)
  return id
}

/** 列某文档的快照（按 id 降序，新的在前；id 是 ULID 时间排序）。 */
export function listSnapshots(snapshotsDir: string, docId: string): SnapshotInfo[] {
  const dir = join(snapshotsDir, docId)
  if (!existsSync(dir)) return []
  const out: SnapshotInfo[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._') || !name.endsWith('.md')) continue
    out.push({ id: name.slice(0, -3), path: join(dir, name) })
  }
  return out.sort((a, b) => b.id.localeCompare(a.id))
}

/** 读单个快照：剥 front matter → 内容 + 元信息。文件缺失/损坏返回 null。 */
export function readSnapshot(
  snapshotsDir: string,
  docId: string,
  id: string,
): { content: string; meta: SnapshotMeta & { time: number } } | null {
  // id 防穿越：ULID 是 26 位 Crockford base32，不含分隔符
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null
  const file = join(snapshotsDir, docId, `${id}.md`)
  if (!existsSync(file)) return null
  const r = readFile(file)
  if (!r.ok) return null
  const map = parseFlat(r.fmRaw)
  const meta: SnapshotMeta & { time: number } = {
    origin: String(map.get('来源') ?? ''),
    time: decodeUlidTime(id),
  }
  const reason = map.get('原因')
  if (reason) meta.reason = String(reason)
  const base = map.get('基线')
  if (base) meta.baseRevision = String(base) as Revision
  return { content: r.body, meta }
}

/** 列快照（对外：含时间/来源/原因/字数，供 UI 展示）。 */
export function listSnapshotEntries(
  snapshotsDir: string,
  docId: string,
  countWords: (text: string) => number,
): SnapshotEntry[] {
  const out: SnapshotEntry[] = []
  for (const s of listSnapshots(snapshotsDir, docId)) {
    const read = readSnapshot(snapshotsDir, docId, s.id)
    if (!read) continue
    out.push({
      id: s.id,
      time: read.meta.time,
      origin: read.meta.origin,
      reason: read.meta.reason ?? '',
      words: countWords(read.content),
    })
  }
  return out
}

/**
 * 分层保留清理（Time Machine 式）：越近越细，越远越粗，匹配真实需求分布——
 * 刚写的想细粒度退，几天前只需一个锚点。
 *
 * | 最近 2 小时      | 全留               |
 * | 2 - 24 小时      | 每小时 1 个（取最早）|
 * | 1 天 - maxDays   | 每天 1 个（取最早）  |
 * | 超过 maxDays     | 删                 |
 * | 总数超 maxCount  | 从最旧删（兜底）     |
 *
 * @returns 删除的快照数
 */
export function pruneSnapshots(
  snapshotsDir: string,
  docId: string,
  policy: SnapshotPolicy = DEFAULT_SNAPSHOT_POLICY,
  now: number = Date.now(),
): number {
  const all = listSnapshots(snapshotsDir, docId)
  if (!all.length) return 0

  // 升序（旧→新）遍历，每个时间桶的第一个即该桶最早的
  const ascending = [...all].reverse()
  const keep = new Set<string>()
  const hourBuckets = new Set<number>()
  const dayBuckets = new Set<number>()
  const maxAge = policy.maxDays * DAY_MS

  for (const s of ascending) {
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

  // 数量兜底：留最新的 maxCount 个（all 已按 id 降序）
  if (keep.size > policy.maxCount) {
    const survivors = all.filter((s) => keep.has(s.id)).slice(0, policy.maxCount)
    keep.clear()
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
      unlinkSync(join(snapshotsDir, docId, `._${s.id}.md`))
    } catch {
      /* 没有就算了 */
    }
  }
  return removed
}
