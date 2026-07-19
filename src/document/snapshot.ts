/**
 * 快照 snapshot（W0-1 §7）—— 全文 + 元信息，用于冲突覆盖前/定稿章首改前等恢复点。
 *
 * 落点：工作区/.snapshots/<docId>/<ULID>.md（gitignore）。id 即 ULID，含时间戳可排序。
 * 用 atomicWriteFile 整文件写（快照是独立文件，非追加日志）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { ulid } from './stable-id.js'
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

/** 建快照：全文 + front matter 元信息（origin/reason/baseRevision）。返回快照 id（ULID，可排序）。 */
export function writeSnapshot(
  snapshotsDir: string,
  docId: string,
  content: string,
  meta: SnapshotMeta,
): string {
  const id = ulid()
  const ts = new Date().toISOString()
  const front: string[] = ['---', `快照ID: ${id}`, `时间: ${ts}`, `来源: ${meta.origin}`]
  if (meta.reason) front.push(`原因: ${meta.reason}`)
  if (meta.baseRevision) front.push(`基线: ${meta.baseRevision}`)
  front.push('---', '')
  const file = join(snapshotsDir, docId, `${id}.md`)
  atomicWriteFile(file, front.join('\n') + content)
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
