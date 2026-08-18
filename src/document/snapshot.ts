/**
 * 快照 snapshot —— 保留为兼容别名层（去 git 版本系统过渡期）。
 *
 * 真实实现已泛化为 version.ts（统一编辑快照 + 定稿版本，pinned 永久保留）。
 * 目录 `工作区/.版本/`（原 .snapshots 首次启动自动迁移）。本模块薄委托 version.ts，
 * 保持既有调用方（service.ts / draft.ts / snapshots API）零改动。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  writeVersion,
  readVersion,
  pruneVersions,
  listVersionEntries,
  DEFAULT_VERSION_POLICY,
  VERSIONS_DIR_NAME,
  LEGACY_SNAPSHOTS_DIR_NAME,
  migrateVersionsDir,
  type VersionMeta,
  type VersionInfo,
  type VersionEntry,
  type VersionPolicy,
  type WriteVersionOptions,
} from './version.js'

/** 快照目录名（工作区/ 下）。 */
export const SNAPSHOTS_DIR_NAME = VERSIONS_DIR_NAME
/** 旧目录名（迁移源）。 */
export const LEGACY_SNAPSHOTS_DIR_NAME_ALIAS = LEGACY_SNAPSHOTS_DIR_NAME

export type SnapshotMeta = VersionMeta
export type SnapshotInfo = VersionInfo
export type SnapshotEntry = VersionEntry
export type SnapshotPolicy = VersionPolicy
export type WriteSnapshotOptions = WriteVersionOptions

export const DEFAULT_SNAPSHOT_POLICY: VersionPolicy = DEFAULT_VERSION_POLICY

export function writeSnapshot(
  snapshotsDir: string,
  docId: string,
  content: string,
  meta: SnapshotMeta,
  options: WriteSnapshotOptions = {},
): string | null {
  return writeVersion(snapshotsDir, docId, content, meta, options)
}

export function readSnapshot(
  snapshotsDir: string,
  docId: string,
  id: string,
): { content: string; meta: SnapshotMeta & { time: number } } | null {
  return readVersion(snapshotsDir, docId, id) as { content: string; meta: SnapshotMeta & { time: number } } | null
}

export function listSnapshotEntries(
  snapshotsDir: string,
  docId: string,
  countWords: (text: string) => number,
): SnapshotEntry[] {
  return listVersionEntries(snapshotsDir, docId, countWords)
}

export function pruneSnapshots(
  snapshotsDir: string,
  docId: string,
  policy: SnapshotPolicy = DEFAULT_SNAPSHOT_POLICY,
  now: number = Date.now(),
): number {
  return pruneVersions(snapshotsDir, docId, policy, now)
}

/** 读全局保留策略（userData/global.json 的 snapMaxDays / snapMaxCount，三层链的中间层：
 *  book.yaml snapshots → global.json snapMax* → 硬编码默认）。
 *  容错：目录未定位 / 文件不存在 / JSON 损坏 / 值非正整数 → 该项 undefined（上层继续回退）。 */
export function readGlobalSnapshotPolicy(userDataPath: string | null): { maxDays?: number; maxCount?: number } {
  if (!userDataPath) return {}
  const p = join(userDataPath, 'global.json')
  if (!existsSync(p)) return {}
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    const posInt = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
    return { maxDays: posInt(raw['snapMaxDays']), maxCount: posInt(raw['snapMaxCount']) }
  } catch {
    return {}
  }
}

export { migrateVersionsDir }