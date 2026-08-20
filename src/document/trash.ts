/**
 * 回收站（W2A §12）—— 工作区/.trash/ 软删恢复缓冲。
 *
 * - 软删：DocumentService.trashDocument 移文件到 .trash/<docId>-<basename> + 记 manifest
 *   + 清单 removeEntry + snapshot 留底 + invalidate（trashDocument 在 service.ts）。
 * - 恢复：restoreTrash 移回 originalPath（原位占用 → OCCUPIED，不自动改，§17 决策④）+
 *   清单恢复 entry + 移除 trash 条目 + invalidate。
 * - 永久删：purgeTrash 物理删 .trash 文件 + 移除 trash 条目（不可逆）。
 *
 * .trash-manifest.jsonl：每行一 TrashEntry，容错解析（同 manifest.ts 风格，非法行跳过）。
 * git 入账（软删 git 跟踪文件 → rebook）走既有 state.ts，本模块只管 .trash 缓冲（W0 §8）。
 *
 * 路径安全（P1 修复）：originalPath/trashedPath 来自 manifest 文件，须经 safePathWithin 校验，
 * 防 manifest 被篡改后 restore/purge 的 rename/rmSync 越出 bookRoot。
 */
import { existsSync, readFileSync, renameSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { resolveWithinRoot } from '../fs/safe-path.js'
import { readManifest, writeManifest, upsertEntry, type ManifestEntry } from './manifest.js'
import { type DocumentRole } from './layout.js'
import { invalidateTreeIndex } from './tree.js'

/** 回收站条目。 */
export interface TrashEntry {
  /** 原 docId（清单身份保留，恢复时回到此 id）。 */
  id: string
  /** 软删前路径（恢复目标）。 */
  originalPath: string
  /** 工作区/.trash/<docId>-<basename> 实际落点（相对 bookRoot）。 */
  trashedPath: string
  trashedAt: string
  role: DocumentRole
  /** W-P2-1：软删前的定稿基线（无 = 从未定稿）。恢复时带回清单——丢了基线，
   *  已定稿章恢复后被当草稿态续写，ensureChapterNotFinalized 失守，AI 可覆盖曾定稿内容。 */
  finalizedRevision?: string
  finalizedAt?: string
}

export type RestoreResult =
  | { ok: true; id: string; path: string }
  | { ok: false; code: 'NOT_FOUND' | 'OCCUPIED' | 'WRITE_ERROR'; reason: string }

export type PurgeResult =
  | { ok: true; id: string }
  | { ok: false; code: 'NOT_FOUND' | 'WRITE_ERROR'; reason: string }

const TRASH_DIR_REL = '工作区/.trash'
const TRASH_MANIFEST_REL = '工作区/.trash/.trash-manifest.jsonl'

function trashManifestPath(bookRoot: string): string {
  return join(bookRoot, TRASH_MANIFEST_REL)
}

/** 读 trash manifest（容错，非法行跳过）。无文件 → 空。 */
export function readTrashManifest(bookRoot: string): TrashEntry[] {
  const p = trashManifestPath(bookRoot)
  if (!existsSync(p)) return []
  const entries: TrashEntry[] = []
  // X-P3a：existsSync 与 read 之间有竞态（并发删/权限变化），读失败按无 manifest 处理
  let raw: string
  try {
    raw = readFileSync(p, 'utf-8')
  } catch {
    return []
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t) as Partial<TrashEntry>
      if (o.id && o.originalPath && o.trashedPath) {
        entries.push({
          id: o.id,
          originalPath: o.originalPath,
          trashedPath: o.trashedPath,
          trashedAt: o.trashedAt ?? '',
          role: (o.role as DocumentRole) ?? 'note',
          // W-P2-1：定稿基线随条目落账/读回（旧条目无此字段 → undefined，按从未定稿处理）
          ...(o.finalizedRevision ? { finalizedRevision: o.finalizedRevision, finalizedAt: o.finalizedAt } : {}),
        })
      }
    } catch {
      continue // 非法行跳过（损坏降级）
    }
  }
  return entries
}

/** 原子写 trash manifest（全量重写，atomicWriteFile）。 */
function writeTrashManifest(bookRoot: string, entries: TrashEntry[]): void {
  mkdirSync(join(bookRoot, TRASH_DIR_REL), { recursive: true })
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')
  // P2-BE-5：加 fsync——回收站 manifest 是「删除可还原」的承诺，掉电丢失即永久丢还原入口
  atomicWriteFile(trashManifestPath(bookRoot), text, { fsync: true })
}

/** 追加 trash 条目（DocumentService.trashDocument 用；同 id 替换，幂等）。 */
export function appendTrashEntry(bookRoot: string, entry: TrashEntry): void {
  const entries = readTrashManifest(bookRoot)
  const idx = entries.findIndex((e) => e.id === entry.id)
  if (idx >= 0) entries[idx] = entry
  else entries.push(entry)
  writeTrashManifest(bookRoot, entries)
}

/** 列回收站。 */
export function listTrash(bookRoot: string): TrashEntry[] {
  return readTrashManifest(bookRoot)
}

/**
 * 恢复：移回 originalPath + 清单恢复 entry + 移除 trash 条目 + invalidate。
 * 原位占用 → OCCUPIED（不自动重命名，§17 决策④）；trash 文件丢失 → NOT_FOUND。
 */
export function restoreTrash(bookRoot: string, id: string): RestoreResult {
  const entries = readTrashManifest(bookRoot)
  const entry = entries.find((e) => e.id === id)
  if (!entry) return { ok: false, code: 'NOT_FOUND', reason: `回收站无 ${id}` }

  const origAbs = safePathWithin(bookRoot, entry.originalPath)
  const trashAbs = safePathWithin(bookRoot, entry.trashedPath)
  if (!origAbs || !trashAbs) {
    return { ok: false, code: 'NOT_FOUND', reason: '回收站条目路径非法（越出书仓库）' }
  }
  if (!existsSync(trashAbs)) return { ok: false, code: 'NOT_FOUND', reason: '回收站文件已丢失' }
  if (existsSync(origAbs)) {
    return {
      ok: false,
      code: 'OCCUPIED',
      reason: `原位 ${entry.originalPath} 已被占用，请先重命名或删除现有文件`,
    }
  }

  try {
    mkdirSync(dirname(origAbs), { recursive: true })
    renameSync(trashAbs, origAbs)
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', reason: `恢复失败：${errMsg(e)}` }
  }

  // P2-BE-4：rename 成功后 manifest 更新改 best-effort（与 doTrash 一致——失败不致文件失踪）
  try {
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    const m = existsSync(manifestPath)
      ? readManifest(manifestPath)
      : { version: 1, entries: new Map<string, ManifestEntry>() }
    upsertEntry(m, {
      id: entry.id,
      nodeType: 'document',
      path: entry.originalPath,
      parentId: null,
      // W-P2-1：恢复时带回定稿基线，还原定稿态（防线/状态机/手改检测都依赖它）
      ...(entry.finalizedRevision
        ? { finalizedRevision: entry.finalizedRevision, ...(entry.finalizedAt ? { finalizedAt: entry.finalizedAt } : {}) }
        : {}),
    })
    mkdirSync(dirname(manifestPath), { recursive: true })
    writeManifest(manifestPath, m)
  } catch { /* 主清单写失败不阻断恢复——树重建时自动补录 */
  }

  try {
    writeTrashManifest(bookRoot, entries.filter((e) => e.id !== id))
  } catch { /* trash manifest 写失败：条目残留，下次恢复报 NOT_FOUND，无害 */
  }
  invalidateTreeIndex(bookRoot, true)
  return { ok: true, id, path: entry.originalPath }
}

/** 永久删：物理删 .trash 文件 + 移除 trash 条目（不可逆，前端二次确认）。 */
export function purgeTrash(bookRoot: string, id: string): PurgeResult {
  const entries = readTrashManifest(bookRoot)
  const entry = entries.find((e) => e.id === id)
  if (!entry) return { ok: false, code: 'NOT_FOUND', reason: `回收站无 ${id}` }
  try {
    const trashAbs = safePathWithin(bookRoot, entry.trashedPath)
    if (!trashAbs) return { ok: false, code: 'NOT_FOUND', reason: '回收站条目路径非法（越出书仓库）' }
    if (existsSync(trashAbs)) rmSync(trashAbs, { force: true })
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', reason: `永久删失败：${errMsg(e)}` }
  }
  writeTrashManifest(bookRoot, entries.filter((e) => e.id !== id))
  return { ok: true, id }
}

/** 路径安全：rel 须相对 bookRoot 且不越出（防 trash-manifest 篡改后 restore/purge 越出书仓库）。
 *  批 6 统一：委托 resolveWithinRoot（防穿越 + symlink 双侧 realpath，fail-closed）。
 *  返回绝对路径或 null（非法）。 */
function safePathWithin(bookRoot: string, rel: string): string | null {
  return resolveWithinRoot(bookRoot, rel)?.abs ?? null
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
