/**
 * 书库文件树扫描 + 构建 + 内存缓存（W2A §6·§9）。
 *
 * 混合模型：目录扫描派生（无 docId），叶子文档合并清单（docId）+ 八态派生（status）。
 * 卷级分层：定稿/正文/<卷>/ 真实磁盘目录，按 localeCompare(zh-Hans-CN) 排序（§6.2，不引入 order）。
 * 工作区内部目录不进树（W0 §9 注：.trash/.journal/.snapshots/待定稿/.confirm.json/.ai-calls.json）。
 *
 * BookTreeIndex 进程内缓存：跨请求共享，结构性 mutation 后 invalidateTreeIndex 失效。
 * watcher 不做（0 依赖红线）——外部编辑器改动靠前端手动刷新触发 rescan。
 */
import { readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { roleOf, type DocumentRole } from './layout.js'
import { readManifest, type ManifestEntry } from './manifest.js'
import { collectDirtyFiles, deriveStatusFull, type DocumentStatus } from './status.js'
import { legacyId } from './stable-id.js'

/** 树节点（扫描派生）。 */
export interface TreeNode {
  /** 相对 bookRoot，正斜杠，无尾斜杠（目录与文件统一）。 */
  path: string
  /** 展示名：目录原名，文件去 .md 后缀。 */
  name: string
  isDirectory: boolean
  /** 叶子 = roleOf(path)；目录占位 'note'（UI 不依赖目录 role，按 path 前缀判区域）。 */
  role: DocumentRole
  children: TreeNode[]
  /** 叶子文档：清单登记的稳定 ID；无清单 → legacyId(path) 运行期临时 ID。 */
  docId?: string
  /** 叶子文档：八态派生（status.ts）。目录无。 */
  status?: DocumentStatus
  /** 卷目录专属：关联卷纲 path（大纲/卷纲/<卷>.md）；无关联 undefined。 */
  volumeOutlinePath?: string
}

/** 树缓存（§9.1）。revision 是树版本号，≠ DocumentService 的内容 revision。 */
export interface BookTreeIndex {
  bookRoot: string
  nodes: TreeNode[]
  /** 树版本号，进程级单调递增，前端据此判新。 */
  revision: number
  validatedAt: string
}

/** 全局跳过目录（任何层级都不扫：运行时 / 版本库 / 依赖 / 系统垃圾）。 */
const SKIP_DIRS = new Set(['.git', '.cache', '.clwriting', 'node_modules', '.DS_Store'])
/** 工作区/ 下跳过的内部资产（W0 §9 注）——目录与文件名混合，按名匹配。 */
const SKIP_WORKDIR_ENTRIES = new Set([
  '.trash', '.journal', '.snapshots', '待定稿', '.confirm.json', '.ai-calls.json',
])

/** 扫描书库 → 嵌套 TreeNode（目录优先 + localeCompare zh-Hans-CN 排序）。 */
export function scanBookTree(bookRoot: string): TreeNode[] {
  return scanDir(bookRoot, '')
}

function scanDir(bookRoot: string, relDir: string): TreeNode[] {
  const absDir = relDir ? join(bookRoot, relDir) : bookRoot
  let entries: Dirent[]
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return [] // 目录不存在 / 无读权限 → 空（容错）
  }
  const nodes: TreeNode[] = []
  const inWorkdir = relDir === '工作区'
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    if (inWorkdir && SKIP_WORKDIR_ENTRIES.has(e.name)) continue
    const rel = relDir ? `${relDir}/${e.name}` : e.name
    if (e.isDirectory()) {
      nodes.push({
        path: rel, name: e.name, isDirectory: true,
        role: 'note', children: scanDir(bookRoot, rel),
      })
    } else if (e.isFile()) {
      nodes.push({
        path: rel, name: stripMd(e.name), isDirectory: false,
        role: roleOf(rel), children: [],
      })
    }
  }
  nodes.sort(compareNode)
  return nodes
}

/** 排序：目录优先于文件，同类型按 path localeCompare(zh-Hans-CN)（§6.2 卷字母序）。 */
function compareNode(a: TreeNode, b: TreeNode): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
  return a.path.localeCompare(b.path, 'zh-Hans-CN')
}

/** basename 去 .md 后缀（文件展示名）。 */
function stripMd(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

/**
 * 扫描 + 合并清单 + 八态派生 + 卷纲关联 → 可展示树。
 * - 叶子 docId：清单 entry.id；无清单 → legacyId(path)（旧书首次结构性操作时升级落盘）。
 * - 叶子 status：deriveStatusFull（git 判脏 + frontmatter 已发布）。
 * - 卷目录 volumeOutlinePath：定稿/正文/<卷>/ ↔ 大纲/卷纲/<卷>.md 同名 stem 关联（§6.2）。
 */
export function buildTree(bookRoot: string): TreeNode[] {
  const nodes = scanBookTree(bookRoot)
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const entryByPath = new Map<string, ManifestEntry>()
  for (const e of manifest.entries.values()) {
    if (e.nodeType === 'document') entryByPath.set(e.path, e)
  }
  const dirty = collectDirtyFiles(bookRoot)
  const volumeStems = collectVolumeOutlineStems(bookRoot)
  annotate(nodes, bookRoot, entryByPath, dirty, volumeStems)
  return nodes
}

/** 收集 大纲/卷纲/*.md 的 stem（卷目录关联用）。无该目录 → 空集。 */
function collectVolumeOutlineStems(bookRoot: string): Set<string> {
  const set = new Set<string>()
  try {
    for (const f of readdirSync(join(bookRoot, '大纲', '卷纲'))) {
      if (f.endsWith('.md')) set.add(f.slice(0, -3))
    }
  } catch {
    // 无 大纲/卷纲 目录 → 空集（短篇 / 旧书）
  }
  return set
}

/** 递归填 docId/status/volumeOutlinePath。 */
function annotate(
  nodes: TreeNode[],
  bookRoot: string,
  entryByPath: Map<string, ManifestEntry>,
  dirty: Set<string>,
  volumeStems: Set<string>,
): void {
  for (const n of nodes) {
    if (!n.isDirectory) {
      const entry = entryByPath.get(n.path)
      n.docId = entry?.id ?? legacyId(n.path)
      n.status = deriveStatusFull(bookRoot, n.path, dirty)
    } else {
      const volName = matchVolumeName(n.path)
      if (volName && volumeStems.has(volName)) {
        n.volumeOutlinePath = `大纲/卷纲/${volName}.md`
      }
    }
    if (n.children.length > 0) {
      annotate(n.children, bookRoot, entryByPath, dirty, volumeStems)
    }
  }
}

/** 定稿/正文/<卷> → <卷>（卷目录名，直接子级）；正文根或更深层（卷里的章）→ null。 */
function matchVolumeName(path: string): string | null {
  const prefix = '定稿/正文/'
  if (!path.startsWith(prefix)) return null
  const rest = path.slice(prefix.length)
  if (rest === '' || rest.includes('/')) return null
  return rest
}

// ── 内存缓存（§9.1）──────────────────────────────

/** 进程级 revision 计数器：跨 invalidate 单调递增，前端据此判新。 */
let globalRevision = 0
const indexes = new Map<string, BookTreeIndex>()

/** 读树缓存；无则重建并缓存。revision 进程级递增（即使跨 invalidate 也单调）。 */
export function getBookTreeIndex(bookRoot: string): BookTreeIndex {
  const cached = indexes.get(bookRoot)
  if (cached) return cached
  const index: BookTreeIndex = {
    bookRoot,
    nodes: buildTree(bookRoot),
    revision: ++globalRevision,
    validatedAt: new Date().toISOString(),
  }
  indexes.set(bookRoot, index)
  return index
}

/** 结构性 mutation 后失效缓存（下次 getBookTreeIndex 重建，revision 递增）。 */
export function invalidateTreeIndex(bookRoot: string): void {
  indexes.delete(bookRoot)
}
