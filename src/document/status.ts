/**
 * 文档级六态派生（去 git 自管版本系统）。
 *
 * 状态是文档级投影，权威 = 磁盘内容指纹 + manifest 定稿基线（去 git 方案）。
 * 核心三态只回答一个问题：**当前内容 与 最后一次定稿内容 是否一致**。
 * - 从未定稿过（无 finalizedRevision）→ draft
 * - 定稿过但内容不同 → revision
 * - 定稿过且内容一致 → final
 *
 * （idea = 工作区笔记，published = frontmatter `已发布` 字段，archived = 废稿目录——
 * 三者不依赖定稿基线，路径判定即可。）
 *
 * 0 运行时依赖：复用 src/format/frontmatter.ts（容错解析）+ src/document/manifest.ts（基线）。
 * 不调用任何外部进程（git/shell）——纯内容 + 账本推导。
 */
import { readFile, parseFlat } from '../format/frontmatter.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ManifestEntry } from './manifest.js'

/** 文档级六态（W0 §3）。 */
export type DocumentStatus =
  | 'idea' | 'draft' | 'revision' | 'final' | 'published' | 'archived'

/**
 * 派生单文件 status（纯函数，不判 published）。
 * - archived：废稿/ 前缀
 * - draft：正文区从未定稿（无 finalizedRevision）或 工作区/待定稿
 * - revision：定稿基线存在但当前指纹不同（定稿后有改动）
 * - final：当前指纹 == 定稿基线（干净）
 *
 * @param entry 文档清单条目（null = 未登记/磁盘手建文件）
 * @param currentRevision 文件实时字节指纹；文件不存在 = null
 * @returns 六态之一
 */
export function deriveStatus(
  relPath: string,
  entry: ManifestEntry | null,
  currentRevision: string | null,
): DocumentStatus {
  if (relPath.startsWith('废稿/')) return 'archived'
  if (relPath.startsWith('工作区/')) {
    const name = relPath.slice('工作区/'.length)
    if (name.startsWith('待定稿/')) return 'draft'
    return 'idea'
  }
  const finRev = entry?.finalizedRevision
  if (!finRev) return 'draft' // 从未定稿 → 草稿
  if (currentRevision && finRev !== currentRevision) return 'revision' // 定稿后有改动
  return 'final' // 定稿且干净
}

/**
 * 读文件 frontmatter `已发布` 字段（published 唯一落盘字段，W0 §3 + §17 决策③）。
 * 无 frontmatter / 无字段 / 字段非 true / 文件不存在 → false。坏文件容错降级 false。
 */
export function readPublished(bookRoot: string, relPath: string): boolean {
  const full = join(bookRoot, relPath)
  if (!existsSync(full)) return false
  const r = readFile(full)
  if (!r.ok) return false
  const fm = parseFlat(r.fmRaw)
  const v = fm.get('已发布')
  // parseValue（frontmatter.ts）不推断 boolean，true 落盘为字符串 "true"；兼容两种防御未来扩展
  return v === true || v === 'true'
}

/**
 * 派生完整 status（含 published）—— deriveStatus + readPublished 组合。
 * 仅当派生为 final 时查 published（revision/脏改优先于 published：脏的已发布章仍是 revision）。
 */
export function deriveStatusFull(
  bookRoot: string,
  relPath: string,
  entry: ManifestEntry | null,
  currentRevision: string | null,
): DocumentStatus {
  const s = deriveStatus(relPath, entry, currentRevision)
  if (s === 'final' && readPublished(bookRoot, relPath)) return 'published'
  return s
}