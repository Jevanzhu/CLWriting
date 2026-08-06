/**
 * 文档级六态派生（W0 §3 裁决 R3）。
 *
 * 状态是文档级投影，权威 = 磁盘 + git（六态状态机语境）；除「published」外不落独立字段，
 * 结构上杜绝账实漂移。清单里的 status 仅为缓存投影，可随时从本模块重建。
 *
 * 性能：collectDirtyFiles 一次 `git status --porcelain` 拿全书脏文件集，deriveStatus 是
 * 纯函数查表，避免逐文件调 git。tree.ts buildTree 调一次 collectDirtyFiles 后逐节点派生。
 *
 * 0 运行时依赖：复用 src/git/exec.ts（spawnSync）+ src/format/frontmatter.ts（容错解析）。
 */
import { statusPorcelain } from '../git/exec.js'
import { readFile, parseFlat } from '../format/frontmatter.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 文档级六态（W0 §3）。 */
export type DocumentStatus =
  | 'idea' | 'draft' | 'revision' | 'final' | 'published' | 'archived'

/**
 * 文件状态集（git porcelain 解析）：untracked = 新文件（draft），modified = tracked+dirty（revision）。
 */
export interface FileStatuses {
  /** git untracked（?? 前缀）——正文区新文件 → draft 状态 */
  untracked: Set<string>
  /** git tracked+modified（非 ?? 前缀）——已跟踪但有变更 → revision 状态 */
  modified: Set<string>
}

/**
 * 一次 git status --porcelain -uall 拿 untracked/modified 双集（相对 bookRoot，正斜杠）。
 * -uall 展开 untracked 目录为具体文件路径（正文区新建卷目录里的草稿不漏报）。
 * git 不可用（非仓库 / 命令失败）→ 双空集降级（派生回退 final，宁放行不误报）。
 */
export function collectFileStatuses(bookRoot: string): FileStatuses {
  const out = statusPorcelain(bookRoot, true)
  const untracked = new Set<string>()
  const modified = new Set<string>()
  if (!out) return { untracked, modified }
  for (const line of out.split('\n')) {
    if (line.length < 4) continue
    const isUntracked = line[0] === '?' && line[1] === '?'
    let p = line.slice(3)
    if ((line[0] === 'R' || line[0] === 'C') && p.includes(' -> ')) {
      p = p.split(' -> ')[1] ?? p
    }
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
    if (p) {
      if (isUntracked) untracked.add(p)
      else modified.add(p)
    }
  }
  return { untracked, modified }
}

/**
 * 向后兼容：untracked+modified 合并为一个脏文件集。
 * 新代码应优先用 collectFileStatuses 区分 untracked/modified。
 */
export function collectDirtyFiles(bookRoot: string): Set<string> {
  const { untracked, modified } = collectFileStatuses(bookRoot)
  return new Set([...untracked, ...modified])
}

/**
 * 派生单文件 status（纯函数，不判 published）。
 * - archived：废稿/ 前缀
 * - draft：正文区 git untracked（新建未定稿的草稿）
 * - revision：正文/设定等区 git modified（已跟踪但有手改）
 * - final：正文/设定等区文件干净（默认良好态）
 *
 * published 由 readPublished 单独查（避免对所有 final 文件读 frontmatter）。
 */
export function deriveStatus(
  relPath: string,
  untracked: Set<string>,
  modified: Set<string>,
): DocumentStatus {
  if (relPath.startsWith('废稿/')) return 'archived'
  if (relPath.startsWith('工作区/')) {
    const name = relPath.slice('工作区/'.length)
    if (name.startsWith('待定稿/')) return 'draft'
    return 'idea'
  }
  // 正文 / 大纲 / 设定 / 布线 等：untracked → draft；modified → revision；clean → final
  if (untracked.has(relPath)) return 'draft'
  if (modified.has(relPath)) return 'revision'
  return 'final'
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
  untracked: Set<string>,
  modified: Set<string>,
): DocumentStatus {
  const s = deriveStatus(relPath, untracked, modified)
  if (s === 'final' && readPublished(bookRoot, relPath)) return 'published'
  return s
}
