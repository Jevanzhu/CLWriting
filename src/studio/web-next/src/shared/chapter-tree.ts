/**
 * 章节树纯工具函数（Z-P2-10 自 ChapterTreePanel 拆出）。
 *
 * 全部为无副作用纯函数：树形态判定、章号/卷号推断、祖先收集、待定稿收集、
 * 默认展开集。输入 TreeNode[]（tree.grouped 或 tree.raw），不依赖组件与响应式。
 */
import type { TreeNode } from '../types/tree'
import { parseChapterFileName } from './words'

/** 名称校验（原 FileTree.sanitizeName）：空/含路径分隔符/点开头/控制字符 → null。 */
export function sanitizeName(value: string): string | null {
  const v = value.trim()
  if (!v || /[\/\\]/.test(v) || v.startsWith('.') || /[\x00-\x1f]/.test(v)) return null
  return v
}

/** 写作/正文 的直接子目录且无更深层级 → 卷目录。 */
export function isVolumeDir(p: string): boolean {
  const prefix = '写作/正文/'
  if (!p.startsWith(prefix)) return false
  const rest = p.slice(prefix.length)
  return rest !== '' && !rest.includes('/')
}

/** 文件名提取章号（`12-标题` / `第12章…` 两种形态）。 */
export function extractChapterNo(name: string): number | null {
  const m = name.match(/^(?:第)?(\d+)(?:章)?-/) ?? name.match(/第(\d+)章/)
  return m ? Number(m[1]) : null
}

/** 正文根目录节点（v2：写作/正文）。 */
export function writeRootIn(nodes: TreeNode[]): TreeNode | undefined {
  const writeGroup = nodes.find((n) => n.path === '写作')
  return writeGroup?.children.find((c) => c.path === '写作/正文')
}

/** 现有最大章号 + 1（扫 grouped 全树正文文件名）。 */
export function nextChapterNoIn(nodes: TreeNode[]): number {
  let max = 0
  const walk = (ns: TreeNode[]): void => {
    for (const n of ns) {
      if (!n.isDirectory && n.path.startsWith('写作/正文/')) {
        const no = extractChapterNo(n.name)
        if (no && no > max) max = no
      }
      if (n.children.length) walk(n.children)
    }
  }
  walk(nodes)
  return max + 1
}

/** 最后一个卷目录路径（新章节默认落点；无卷 → null）。 */
export function lastVolumePathIn(nodes: TreeNode[]): string | null {
  const vols = (writeRootIn(nodes)?.children ?? []).filter((n) => n.isDirectory && isVolumeDir(n.path))
  return vols.length ? (vols[vols.length - 1]?.path ?? null) : null
}

/** 正文现有卷数（卷纲编号推断：N = 卷数 + 1）。 */
export function volumeCountIn(nodes: TreeNode[]): number {
  return (writeRootIn(nodes)?.children ?? []).filter((n) => n.isDirectory && isVolumeDir(n.path)).length
}

/** 目标节点的祖先目录路径链（不含目标自身）；找不到 → null。 */
export function collectAncestors(ns: TreeNode[], target: string, acc: string[] = []): string[] | null {
  for (const n of ns) {
    if (n.path === target) return acc
    if (n.isDirectory && n.children.length) {
      const r = collectAncestors(n.children, target, [...acc, n.path])
      if (r) return r
    }
  }
  return null
}

/** 章节可移动目标：正文根 + 各卷（排除自身所在目录）。 */
export function moveToTargetsFor(node: TreeNode, nodes: TreeNode[]): { label: string; dir: string }[] {
  const parent = node.path.slice(0, node.path.lastIndexOf('/'))
  const targets: { label: string; dir: string }[] = [{ label: '正文根', dir: '写作/正文' }]
  for (const v of (writeRootIn(nodes)?.children ?? []).filter((n) => n.isDirectory && isVolumeDir(n.path))) {
    targets.push({ label: v.name, dir: v.path })
  }
  return targets.filter((t) => t.dir !== parent)
}

/**
 * 收集「≤ 目标章号」的所有待定稿正文章（draft/revision）。
 * 从整树 raw 扫（含短篇 piece-body，扁平无卷——章号从文件名取）。
 * 返回 docId 列表（含目标章自身，按章号升序）。
 * 注意：TreeNode.path 是完整相对路径（写作/正文/N-标题.md），章号只能从 name 提取。
 */
export function pendingChaptersUpToIn(target: TreeNode, rawNodes: TreeNode[]): string[] {
  const targetNo = parseChapterFileName(target.name)?.章号
  if (targetNo === undefined) return []
  const out: { no: number; docId: string }[] = []
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (!n.isDirectory && n.docId && (n.status === 'draft' || n.status === 'revision')) {
        const no = parseChapterFileName(n.name)?.章号
        if (no !== undefined && no <= targetNo) out.push({ no, docId: n.docId })
      }
      if (n.children.length) walk(n.children)
    }
  }
  walk(rawNodes)
  return out.sort((a, b) => a.no - b.no).map((x) => x.docId)
}

/** 默认展开：一级目录 + 写作/正文（正文是作者主战场，二级也展开）。 */
export function defaultExpandedDirs(nodes: TreeNode[]): string[] {
  const dirs: string[] = []
  for (const n of nodes) {
    if (!n.isDirectory) continue
    dirs.push(n.path)
    if (n.path === '写作') {
      for (const c of n.children) {
        if (c.isDirectory && c.path === '写作/正文') dirs.push(c.path)
      }
    }
  }
  return dirs
}
