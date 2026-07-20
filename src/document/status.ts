/**
 * 文档级八态派生（W0 §3 裁决 R3）。
 *
 * 状态是文档级投影，权威 = 磁盘 + git（八态状态机语境）；除「published」外不落独立字段，
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

/** 文档级八态（W0 §3）。 */
export type DocumentStatus =
  | 'idea' | 'draft' | 'revision' | 'final' | 'published' | 'archived'

/**
 * 一次 git status --porcelain 拿工作树脏文件 path 集（相对 bookRoot，正斜杠）。
 * git 不可用（非仓库 / 命令失败）→ 空集降级（派生回退 final，宁放行不误报）。
 *
 * porcelain 行格式 `XY <path>`（X/Y 各一字符状态码），path 从 slice(3) 取；
 * 含特殊字符时 git 给 path 加引号，此处去引号。renamed（R）行格式特殊，第一版按 slice(3)
 * 取目标段（源段信息丢失但不影响「脏」判定——rename 本身就是脏）。
 */
export function collectDirtyFiles(bookRoot: string): Set<string> {
  const out = statusPorcelain(bookRoot)
  const set = new Set<string>()
  if (!out) return set
  for (const line of out.split('\n')) {
    // porcelain 固定宽度：2 状态码 + 1 空格 + path（行首空格是状态码的一部分，不动）
    if (line.length < 4) continue
    let p = line.slice(3)
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
    if (p) set.add(p)
  }
  return set
}

/**
 * 派生单文件 status（纯函数，不判 published）。
 * - archived：废稿/ 前缀
 * - draft：工作区/草稿-N.md 或 工作区/待定稿/ 队列（§3）
 * - idea：工作区仅细纲/卡片（无草稿）
 * - revision：定稿区文件在脏集（未 rebook 的手改，态 3 文档视图）
 * - final：定稿区文件干净（默认良好态）
 *
 * published 由 readPublished 单独查（避免对所有 final 文件读 frontmatter）。
 */
export function deriveStatus(relPath: string, dirtyFiles: Set<string>): DocumentStatus {
  if (relPath.startsWith('废稿/')) return 'archived'
  if (relPath.startsWith('工作区/')) {
    const name = relPath.slice('工作区/'.length)
    if (/^草稿-\d+\.md$/.test(name)) return 'draft'
    if (name.startsWith('待定稿/')) return 'draft'
    return 'idea'
  }
  // 定稿区 / 大纲 / 设定 等：git 判脏
  return dirtyFiles.has(relPath) ? 'revision' : 'final'
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
  dirtyFiles: Set<string>,
): DocumentStatus {
  const s = deriveStatus(relPath, dirtyFiles)
  if (s === 'final' && readPublished(bookRoot, relPath)) return 'published'
  return s
}
