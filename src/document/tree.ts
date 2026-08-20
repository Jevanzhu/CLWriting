/**
 * 书库文件树扫描 + 构建 + 内存缓存（W2A §6·§9）。
 *
 * 混合模型：目录扫描派生（无 docId），叶子文档合并清单（docId）+ 六态派生（status）。
 * 卷级分层：写作/正文/<卷>/ 真实磁盘目录，按 localeCompare(zh-Hans-CN) 排序（§6.2，不引入 order）。
 * 工作区内部目录不进树（W0 §9 注：.trash/.journal/.版本/待定稿/.confirm.json/.ai-calls.json）。
 *
 * BookTreeIndex 进程内缓存：跨请求共享，结构性 mutation 后 invalidateTreeIndex 失效。
 * watcher 不做（0 依赖红线）——外部编辑器改动靠前端手动刷新触发 rescan。
 */
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { roleOf, type DocumentRole } from './layout.js'
import { readManifest, type ManifestEntry } from './manifest.js'
import { deriveStatus, type DocumentStatus } from './status.js'
import { legacyId } from './stable-id.js'
import { splitFrontMatter } from '../format/frontmatter.js'
import { countWords } from '../format/words.js'
import { clearTreeIssuesCacheForBook } from '../check/tree-issues-cache.js'

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
  /** 叶子文档：六态派生（status.ts）。目录无。 */
  status?: DocumentStatus
  /** 叶子文档：正文字数（countWords 剥 fm 后码点数；仅 chapter/piece-body/draft）。目录无。 */
  wordCount?: number
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

/** 全局跳过目录（任何层级都不扫：运行时 / 版本库 / 依赖 / 系统垃圾 / 幕后资产）。
 *  v2：工作区（运行时资产）、文风（幕后）、定稿（仅剩摘要/脚本产物）、项目（元数据）不进树。 */
const SKIP_DIRS = new Set(['.git', '.cache', '.clwriting', 'node_modules', '.DS_Store', '工作区', '文风', '定稿', '项目'])
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
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
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

/** 根级目录展示序（作者工作流优先：写作 → 大纲 → 设定 → 布线）。 */
const ROOT_ORDER = ['写作', '大纲', '设定', '布线']
/** 大纲区单例总纲：置顶展示（最高频入口，优先于目录/字母序）。 */
const SYNOPSIS_TOP = '大纲/总纲.md'

/** 排序：目录优先于文件；根级按 ROOT_ORDER 固定序（工作流优先），
 *  其余层级按 path localeCompare(zh-Hans-CN)（§6.2 卷字母序）；总纲例外置顶。 */
function compareNode(a: TreeNode, b: TreeNode): number {
  // 总纲置顶须先于目录优先判断（总纲是文件，默认排在卷纲/章纲目录后）
  if (a.path === SYNOPSIS_TOP || b.path === SYNOPSIS_TOP) {
    return a.path === SYNOPSIS_TOP ? -1 : 1
  }
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
  const ar = ROOT_ORDER.indexOf(a.path)
  const br = ROOT_ORDER.indexOf(b.path)
  if (ar !== -1 || br !== -1) {
    if (ar !== -1 && br !== -1) return ar - br
    return ar !== -1 ? -1 : 1
  }
  return a.path.localeCompare(b.path, 'zh-Hans-CN')
}

/** basename 去 .md 后缀（文件展示名）。 */
function stripMd(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

/**
 * 扫描 + 合并清单 + 六态派生 + 卷纲关联 → 可展示树。
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
  const volumeStems = collectVolumeOutlineStems(bookRoot)
  annotate(nodes, bookRoot, entryByPath, volumeStems)
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

/** 递归填 docId/status/volumeOutlinePath。W-P2-4：单次读探针（哈希+字数+published 一次带出）。 */
function annotate(
  nodes: TreeNode[],
  bookRoot: string,
  entryByPath: Map<string, ManifestEntry>,
  volumeStems: Set<string>,
): void {
  for (const n of nodes) {
    if (!n.isDirectory) {
      const entry = entryByPath.get(n.path)
      n.docId = entry?.id ?? legacyId(n.path)
      // W-P2-4：一次读文件得到 rev + wordCount + published（原 computeRevision/countWordsOf/readPublished 三读合一）
      const probe = probeFile(bookRoot, n.path)
      const rev = probe?.rev ?? null
      const status = deriveStatus(n.path, entry ?? null, rev)
      n.status = status === 'final' && probe?.published ? 'published' : status
      if (isCountedRole(n.role)) {
        n.wordCount = probe?.wordCount ?? 0
      }
    } else {
      const volName = matchVolumeName(n.path)
      if (volName && volumeStems.has(volName)) {
        n.volumeOutlinePath = `大纲/卷纲/${volName}.md`
      }
    }
    if (n.children.length > 0) {
      annotate(n.children, bookRoot, entryByPath, volumeStems)
    }
  }
}

/** 字数统计的正文角色：长篇正文 chapter / 短篇正文 piece-body / 工作区草稿 draft。 */
function isCountedRole(role: DocumentRole): boolean {
  return role === 'chapter' || role === 'piece-body'
}

// ── W-P2-4：树单次读 + 哈希缓存 ─────────────────────────────

/** 单文件探测结果：一次 readFileSync 同时得到哈希 + 字数 + 已发布标志（原三读合一）。 */
interface FileProbe {
  rev: `sha256:${string}`
  wordCount: number
  published: boolean
}

/**
 * 进程级哈希缓存：path + (mtimeMs,size) → probe。
 * 文件未变（stat 级检测）→ 复用，跳过整文件读 + SHA-256（200 万字树的重灾区）。
 * 缓存无上限但按书隔离（键带 bookRoot），进程内树重建频次远低于文件量，可接受。
 */
const probeCache = new Map<string, { mtimeMs: number; size: number; probe: FileProbe }>()

/** 清空哈希缓存（结构性 mutation 后由 invalidateTreeIndex 调用）。 */
export function clearProbeCache(): void {
  probeCache.clear()
}

/**
 * CC-P1-3：字节指纹的缓存版（computeRevision 语义，stat 级复用 probeCache）。
 * 树红点聚合每章一调——未变文件（绝大多数）stat 命中零读零哈希，替代每章整读 + SHA-256；
 * 结构性 mutation 时随 invalidateTreeIndex 一并失效。mtime+size 撞车理论窗口与树自身
 * W-P2-4 probeCache 同口径。文件不存在/读失败 → null（调用方容错）。
 */
export function probeCachedRevision(bookRoot: string, relPath: string): `sha256:${string}` | null {
  return probeFile(bookRoot, relPath)?.rev ?? null
}

/**
 * #6 配套：published 的缓存版（readPublished 的 final 分支语义，stat 级复用 probeCache）。
 * 树红点聚合对 final 章逐章判定 published——此前 deriveStatusFull → readPublished 每章
 * 整读定稿稿且不吃缓存，成熟书 O(final 章数) 整读/请求；与 probeCachedRevision 同一
 * probe（一次 stat 两用，零额外读），口径与树视图（annotate）一致。
 */
export function probeCachedPublished(bookRoot: string, relPath: string): boolean {
  return probeFile(bookRoot, relPath)?.published ?? false
}

/**
 * 单次读取文件 → { rev, wordCount, published }。
 * - rev：文件字节 SHA-256（computeRevision 同源 hashFile 语义）
 * - wordCount：剥 fm 后码点数（原 countWordsOf）
 * - published：fm `已发布` == true/'true'（原 readPublished 的 final 分支才读，这里一次带出）
 * 文件不存在/读失败 → null（调用方容错）。
 */
function probeFile(bookRoot: string, rel: string): FileProbe | null {
  const full = join(bookRoot, rel)
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(full)
  } catch {
    return null
  }
  const key = bookRoot + '|' + rel
  const hit = probeCache.get(key)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.probe

  let raw: Buffer
  try {
    raw = readFileSync(full)
  } catch {
    return null
  }
  const rev = ('sha256:' + createHash('sha256').update(raw).digest('hex')) as `sha256:${string}`
  // 字数 + published 都从同一份字节解析（一次读、一次 utf8 解码）
  const text = raw.toString('utf8')
  const split = splitFrontMatter(text)
  const wordCount = countWords(split ? split.body : text)
  let published = false
  if (split) {
    const v = parsePublishedValue(split.fmRaw)
    published = v === true || v === 'true'
  }
  const probe: FileProbe = { rev, wordCount, published }
  probeCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, probe })
  return probe
}

/** 从 fm 原文提取 `已发布` 字段值（与原 readPublished/parseFlat 同口径，内联避免第三读）。 */
function parsePublishedValue(fmRaw: string): boolean | string | undefined {
  const m = fmRaw.match(/^已发布[:：]\s*(.+?)\s*$/m)
  if (!m) return undefined
  const v = m[1]!.trim()
  return v === 'true' ? true : v
}

/** 写作/正文/<卷> → <卷>（卷目录名，直接子级）；正文根或更深层（卷里的章）→ null。 */
function matchVolumeName(path: string): string | null {
  const prefix = '写作/正文/'
  if (!path.startsWith(prefix)) return null
  const rest = path.slice(prefix.length)
  if (rest === '' || rest.includes('/')) return null
  return rest
}

// ── 内存缓存（§9.1）──────────────────────────────

/** 进程级 revision 计数器：跨 invalidate 单调递增，前端据此判新。 */
let globalRevision = 0
const indexes = new Map<string, BookTreeIndex>()

/** 读树缓存；无则重建并缓存。revision 进程级递增（即使跨 invalidate 也单调）。
 *  force=true 丢弃缓存重扫——外部编辑器/CLI 直接改盘不经 invalidateTreeIndex，
 *  前端显式刷新需要这条通路，否则外部改动永远刷不出来。 */
export function getBookTreeIndex(bookRoot: string, force = false): BookTreeIndex {
  const cached = force ? undefined : indexes.get(bookRoot)
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

/**
 * 结构性 mutation 后失效缓存（下次 getBookTreeIndex 重建，revision 递增）。
 *
 * A1（批 1）structural=true：改名/移动/删章/书改名等改变 rel_path 集合的 mutation
 * ——树红点缓存表按 rel_path 键控，旧行成垃圾，整表清空回收（残留不致错——
 * 新路径必 miss——只是防膨胀）。内容保存（draft-pipeline/files）不传：章级
 * (mtime,size) 指纹自会失效对应行，整表连坐会把「改 1 章只重查 1 章」打回全书。
 */
export function invalidateTreeIndex(bookRoot: string, structural = false): void {
  indexes.delete(bookRoot)
  // W-P2-4：文件内容可能已变（保存/回滚/定稿）→ 哈希缓存一并失效，防 mtime 撞车后复用旧哈希
  clearProbeCache()
  if (structural) clearTreeIssuesCacheForBook(bookRoot)
}
