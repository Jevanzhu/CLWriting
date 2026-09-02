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
import { safeManifestPath } from '../fs/safe-path.js'
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
    // L-D5（第八轮）：点开头文件/目录不入树——fs/atomic.ts 崩溃于 write-rename 之间
    // 泄漏的 .<name>.<pid>.<uuid>.tmp 会以 chapter 角色混进树（作者可见幽灵节点）
    if (e.name.startsWith('.')) continue
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

/** 章号提取：文件名前导数字（M-5，第十轮）。兼容存量多种补零宽度混名
 *  （前端新建不补零 `5-x` / 前端复制 4 位 / 服务端长篇 4 位 / 短篇与草稿管线 3 位）；
 *  非数字前缀文件（副本、设定类）返回 null。 */
function chapterNoOf(name: string): number | null {
  const m = /^(\d+)(?:[-—]|\s|$)/.exec(name)
  return m ? Number(m[1]) : null
}

/** 排序：目录优先于文件；根级按 ROOT_ORDER 固定序（工作流优先），
 *  章文件按章号数值序（补零宽度不影响大小），其余按 path localeCompare（§6.2 卷字母序）；总纲例外置顶。 */
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
  // M-5（第十轮）：章号数值优先——localeCompare 纯字典序会把 `5-x` 排到 `020-y`
  // 之后、`0100-y` 排到 `099-x` 之前，目录树实际错序；双方都是数字前缀文件时按
  // 数值比较，数值同（如 `005-x` 与 `5-x` 并存）回落 path 字典序保持稳定
  if (!a.isDirectory) {
    const an = chapterNoOf(a.name)
    const bn = chapterNoOf(b.name)
    if (an !== null && bn !== null && an !== bn) return an - bn
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

/** 字数统计的正文角色：长篇正文 chapter / 短篇正文 piece-body。
 *  Z-15（第五十八轮）注释如实化：draft 从未计入（工作区/ 在树外）；且 roleOf 现产
 *  只出 'chapter'（layout.ts 口径注记），'piece-body'/'draft' 为预留枚举位。 */
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
 * 进程级哈希缓存：path + (mtimeNs,size) → probe。
 * 文件未变（stat 级检测）→ 复用，跳过整文件读 + SHA-256（200 万字树的重灾区）。
 * 低级项（第六轮）：①缓存加上限（FIFO 淘汰，Map 保插入序）——键带 bookRoot 但长期
 * 运行的桌面进程逐书累积无界；上限取单书树规模（200 万字书 ≈ 千级文件）的 4 倍余量。
 * ②指纹 mtimeMs → bigint stat 的 mtimeNs——同 ms 内改回同长内容的撞车窗口收窄到 ns 级。
 */
const PROBE_CACHE_MAX = 4096
const probeCache = new Map<string, { mtimeNs: bigint; size: bigint; probe: FileProbe }>()

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
  // R33D-19（三十三轮）：probe 的调用方传 manifest 登记路径——过 safeManifestPath
  // 防 `../` 条目越出书仓库（stat/hash 只读逃逸面）；非法路径按「文件不存在」语义 null。
  const full = safeManifestPath(bookRoot, rel)
  if (!full) return null
  let st: { mtimeNs: bigint; size: bigint }
  try {
    st = statSync(full, { bigint: true })
  } catch {
    return null
  }
  const key = bookRoot + '|' + rel
  const hit = probeCache.get(key)
  if (hit && hit.mtimeNs === st.mtimeNs && hit.size === st.size) return hit.probe

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
  // FIFO 淘汰最旧（Map 保插入序）
  if (probeCache.size >= PROBE_CACHE_MAX) {
    const oldest = probeCache.keys().next().value
    if (oldest !== undefined) probeCache.delete(oldest)
  }
  probeCache.set(key, { mtimeNs: st.mtimeNs, size: st.size, probe })
  return probe
}

/** 从 fm 原文提取 `已发布` 字段值（与原 readPublished/parseFlat 同口径，内联避免第三读）。
 *  2026-08-21：剥首尾引号——`已发布: "true"` 手写带引号时，parseFlat→parseValue 会 unquote
 *  得 'true'（document 链路判 published），此处原样返回 '"true"' 判 false，树/定稿两链路
 *  口径分裂（注释宣称同口径不实）。 */
function parsePublishedValue(fmRaw: string): boolean | string | undefined {
  const m = fmRaw.match(/^已发布[:：]\s*(.+?)\s*$/m)
  if (!m) return undefined
  // R33-48（三十三轮）：剥引号改「配对才剥」——原 `^["'](.*)["']$` 把 `"true'`
  // （首尾引号不配对）也剥成 true，与 parseFlat 的 unquote 口径偏差（后者配对判定）。
  const v0 = m[1]!.trim()
  const q = v0[0]
  const v =
    (q === '"' || q === "'") && v0.length >= 2 && v0.endsWith(q) ? v0.slice(1, -1) : v0
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

/** 内存闸（2026-08-24）：树索引按 bookRoot 缓存整树、无上限——长跑桌面/服务进程
 *  多书切换逐书累积无界（单书 MB 级）；FIFO 上限对齐 probeCache 口径，取多书同开
 *  常态（8）的 2 倍余量；淘汰后下次 get 重建即可，无正确性影响。 */
const INDEXES_CACHE_MAX = 16

/** 读树缓存；无则重建并缓存。revision 进程级递增（即使跨 invalidate 也单调）。
 *  force=true 丢弃缓存重扫——外部编辑器/CLI 直接改盘不经 invalidateTreeIndex，
 *  前端显式刷新需要这条通路，否则外部改动永远刷不出来。 */
export function getBookTreeIndex(bookRoot: string, force = false): BookTreeIndex {
  const cached = force ? undefined : indexes.get(bookRoot)
  if (cached) return cached
  const nodes = buildTree(bookRoot)
  // R39-19（三十九轮）：force 重建内容不变则不 bump revision——窗口回前台拉全树
  // （ChapterTreePanel 2s 节流 force）此前必 ++globalRevision，前端 doc store
  // syncCleanWithTree 按 revision 判 stale → 全部 clean 文档缓存（上限 20）全量重拉
  //（20 次 GET /file + sha256），「写作中频繁切窗查资料」场景对账永不收敛。结构化
  // 变更（增删改/改名）走 invalidateTreeIndex 删缓存，重建必不等 → revision 照常
  // 递增；外部编辑改动节点 mtime/size/摘要 → 序列化不等 → 照常递增。等价比较用
  // JSON 序列化（同构建路径键序稳定；键序漂移只会退回「视为变更」旧行为，安全侧）；
  // 千章树毫秒级，仅 force 路径付出。
  const prev = indexes.get(bookRoot)
  if (prev && JSON.stringify(prev.nodes) === JSON.stringify(nodes)) {
    prev.validatedAt = new Date().toISOString()
    return prev
  }
  const index: BookTreeIndex = {
    bookRoot,
    nodes,
    revision: ++globalRevision,
    validatedAt: new Date().toISOString(),
  }
  // FIFO 淘汰最旧（Map 保插入序，与 probeCache 同口径）
  if (indexes.size >= INDEXES_CACHE_MAX) {
    const oldest = indexes.keys().next().value
    if (oldest !== undefined) indexes.delete(oldest)
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
  // W-P2-4：文件内容可能已变（保存/回滚/定稿）→ 哈希缓存一并失效，防 mtime 撞车后复用旧哈希。
  // 2026-08-21：按书前缀清理（缓存键本就带 bookRoot）——此前 clearProbeCache() 全局清空，
  // 任一书保存会让其他书首次树聚合退化为全量读（多书同开时的无谓读放大）
  const prefix = bookRoot + '|'
  for (const key of probeCache.keys()) {
    if (key.startsWith(prefix)) probeCache.delete(key)
  }
  if (structural) clearTreeIssuesCacheForBook(bookRoot)
}
