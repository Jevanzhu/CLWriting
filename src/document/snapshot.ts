/**
 * 快照 snapshot —— 保留为兼容别名层（去 git 版本系统过渡期）。
 *
 * 真实实现已泛化为 version.ts（统一编辑快照 + 定稿版本，pinned 永久保留）。
 * 目录 `工作区/.版本/`（原 .snapshots 首次启动自动迁移）。本模块薄委托 version.ts，
 * 保持既有调用方（service.ts / draft.ts / snapshots API）零改动。
 *
 * O-12（第十三轮）退役登记：本层唯二非委托物是 readGlobalSnapshotPolicy（真实实现，
 * 迁移时应挪 version.ts）与 LEGACY_SNAPSHOTS_DIR_NAME_ALIAS。迁移触点清单（5 文件）：
 * src/document/service.ts / src/process/draft-pipeline.ts / src/studio/server/index.ts
 * （migrateVersionsDir 直接已可用 version.js）/ src/studio/server/api/snapshots.ts /
 * test/document/snapshot.test.ts——纯机械改名，零行为变更，随 rc 后重构批执行，
 * 不在修复轮做（回归面 > 收益）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  writeVersion,
  readVersion,
  readVersionRaw,
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
  content: string | Buffer,
  meta: SnapshotMeta,
  options: WriteSnapshotOptions = {},
): string | null {
  // R26-52（二十六轮）：Buffer 透传——结构性留底（移动/删除前）字节档直存，见 version.ts
  return writeVersion(snapshotsDir, docId, content, meta, options)
}

export function readSnapshot(
  snapshotsDir: string,
  docId: string,
  id: string,
): { content: string; meta: SnapshotMeta & { time: number } } | null {
  return readVersion(snapshotsDir, docId, id) as { content: string; meta: SnapshotMeta & { time: number } } | null
}

/** R34D-18（三十四轮）：字节保真读的快照别名委托（readVersionRaw 的兼容层包装）——
 *  恢复端点（api/snapshots.ts restore）用它取原字节，闭合 R26-52「写入保的字节可
 *  无损读出」不变量的调用侧。 */
export function readSnapshotRaw(
  snapshotsDir: string,
  docId: string,
  id: string,
): { content: Buffer; meta: SnapshotMeta & { time: number } } | null {
  return readVersionRaw(snapshotsDir, docId, id) as { content: Buffer; meta: SnapshotMeta & { time: number } } | null
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

/** 读全局保留策略（userData/global.json 的 snapMaxDays / snapMaxCount，两层链的全局层：
 *  global.json snapMax* → 硬编码默认。R34D-20（三十四轮）校正：book.yaml snapshots
 *  书级段 2026-08-19 起已砍除，不参与解析——三层链旧说法作废）。
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