/**
 * 书库文件树扫描 + 构建 + 内存缓存（W2A §6·§9）。
 *
 * 混合模型：目录扫描派生（无 docId），叶子文档合并清单（docId）+ 六态派生（status）。
 * 卷级分层：写作/正文/<卷>/ 真实磁盘目录，按 localeCompare(zh-Hans-CN) 排序（§6.2，不引入 order）。
 * 工作区内部目录不进树（§9 注：.trash/.journal/.版本/待定稿/.confirm.json/.ai-calls.json）。
 *
 * BookTreeIndex 进程内缓存：跨请求共享，结构性 mutation 后 invalidateTreeIndex 失效。
 * watcher 不做（0 依赖红线）——外部编辑器改动靠前端手动刷新触发 rescan。
 */
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { safeManifestPath, docJoinKey } from '../fs/safe-path.js'
import { toNfcName } from '../fs/text-canonical.js'
import { isMdFileName, chapterNoFromName } from '../format/filename.js'
import { createHash } from 'node:crypto'
import { roleOf, type DocumentRole } from './layout.js'
import { readManifest, type ManifestEntry } from './manifest.js'
import { deriveStatus, type DocumentStatus } from './status.js'
import { legacyId } from './stable-id.js'
import { splitFrontMatter, parseValue } from '../format/frontmatter.js'
import { stripInlineComment } from '../format/frontmatter-core.js'
import { countWords } from '../format/words.js'
import { parseOrderOf, isPublishedValue } from '../format/chapters.js'
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
  /** 叶子文档：fm `序` 显示排序键（阶段 24 ；仅 chapter/piece-body，probe 解析）。
   *  缺省 = 文件名章号（排序回落），旧书零迁移。目录无。 */
  order?: number
  /** 卷目录专属：关联卷纲 path（大纲/卷纲/<卷>.md）；无关联 undefined。 */
  volumeOutlinePath?: string
}

/** 树缓存（§9.1）。revision 是树版本号，≠ DocumentService 的内容 revision。 */
interface BookTreeIndex {
  bookRoot: string
  nodes: TreeNode[]
  /** 树版本号，进程级单调递增，前端据此判新。 */
  revision: number
  validatedAt: string
}

/** 全局跳过目录（任何层级都不扫：运行时 / 版本库 / 依赖 / 系统垃圾 / 幕后资产）。
 *  v2：工作区（运行时资产）、文风（幕后）、定稿（仅剩摘要/脚本产物）、项目（元数据）不进树。 */
const SKIP_DIRS = new Set([
  '.git',
  '.cache',
  '.clwriting',
  'node_modules',
  '.DS_Store',
  '工作区',
  '文风',
  '定稿',
  '项目',
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
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    // L-：点开头文件/目录不入树——fs/atomic.ts 崩溃于 write-rename 之间
    // 泄漏的 .<name>.<pid>.<uuid>.tmp 会以 chapter 角色混进树（作者可见幽灵节点）
    if (e.name.startsWith('.')) continue
    const rel = relDir ? `${relDir}/${e.name}` : e.name
    if (e.isDirectory()) {
      nodes.push({
        path: rel,
        name: e.name,
        isDirectory: true,
        role: 'note',
        children: scanDir(bookRoot, rel),
      })
    } else if (e.isFile()) {
      nodes.push({
        path: rel,
        name: stripMd(e.name),
        isDirectory: false,
        role: roleOf(rel),
        children: [],
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

/** 章号提取：文件名前导数字。兼容存量多种补零宽度混名
 *  （前端新建不补零 `5-x` / 前端复制 4 位 / 服务端长篇 4 位 / 短篇与草稿管线 3 位）；
 *  非数字前缀文件（副本、设定类）返回 null。
 *  （GLM-5.3 修复批）：正则本体升格 format/filename.ts
 *  chapterNoFromName 单一真相源（leads/foreshadow/summary 三处窄正则同批收敛）——
 *  ：薄委托包装 chapterNoOf 随批内联删除，本文件调用点
 *  直呼 chapterNoFromName；单一真相源仍在 format/filename.ts（沿革不变）。 */

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
  // 章号数值优先——localeCompare 纯字典序会把 `5-x` 排到 `020-y`
  // 之后、`0100-y` 排到 `099-x` 之前，目录树实际错序；双方都是数字前缀文件时按
  // 数值比较，数值同（如 `005-x` 与 `5-x` 并存）回落 path 字典序保持稳定
  if (!a.isDirectory) {
    const an = chapterNoFromName(a.name)
    const bn = chapterNoFromName(b.name)
    if (an !== null && bn !== null && an !== bn) return an - bn
  }
  return a.path.localeCompare(b.path, 'zh-Hans-CN')
}

/** basename 去 .md 后缀（文件展示名）。：判定单源 isMdFileName
 *  （大小写不敏感）——.MD 文件名此前展示带尾巴，与判定侧（收编）两链不一致。 */
function stripMd(name: string): string {
  return isMdFileName(name) ? name.slice(0, -3) : name
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
  // join 键改 docJoinKey（win32 大小写折叠 + NFC 归一）——原精确
  // 字符串 join 在外部 case-only 改名 / NFD 文件名后失配，docId 落 legacyId 兜底
  const entryByPath = new Map<string, ManifestEntry>()
  for (const e of manifest.entries.values()) {
    if (e.nodeType === 'document') entryByPath.set(docJoinKey(e.path), e)
  }
  const volumeStems = collectVolumeOutlineStems(bookRoot)
  annotate(nodes, bookRoot, entryByPath, volumeStems)
  // （阶段 24）：annotate 后按 fm `序` 重排正文子树（scanDir 阶段无 fm 数据——设计
  // §5.4 排序键接线的既定时机；缺省 = 章号，旧书排序逐位不变）
  sortTreeByOrder(nodes)
  return nodes
}

/**
 * （阶段 24）：`写作/正文` 子树（含卷子目录）的章文件按 `序 ?? 文件名章号` 重排。
 * - 仅正文子树生效：其余目录（大纲/设定/布线等）维持 scanDir 的 localeCompare 现状；
 * - 目录优先/卷目录次序不动（compareNode 语义保留），只重排同目录内的章文件；
 *   （拍板快断6-09-15 维持：显示序 = 卷优先分组 DFS、非跨卷 fm 序全局穿插——
 *   同卷内 fm 序成立即自洽，跨卷改穿插牵树交互语义，收益不明确，阶段 24 批 C 登记
 *   项拍板维持现状）
 * - tie-break：排序键同 → 章号 → path（稳定确定性）；非数字前缀且无 `序` 的文件
 *   不参与重排（键 = +Infinity 沉底，彼此保持原相对序——正文区该形态罕见）。
 */
function sortTreeByOrder(nodes: TreeNode[]): void {
  for (const n of nodes) {
    if (n.children.length === 0) continue
    if (n.path === '写作/正文' || n.path.startsWith('写作/正文/')) {
      const files = n.children.filter((c) => !c.isDirectory)
      if (files.length > 1) {
        const keyOf = (c: TreeNode): number => c.order ?? chapterNoFromName(c.name) ?? Number.POSITIVE_INFINITY
        const noOf = (c: TreeNode): number => chapterNoFromName(c.name) ?? Number.POSITIVE_INFINITY
        files.sort((a, b) => keyOf(a) - keyOf(b) || noOf(a) - noOf(b) || a.path.localeCompare(b.path, 'zh-Hans-CN'))
        // 目录在前（维持 compareNode 目录优先），重排后的章文件接续——sort 稳定，
        // 键全 Infinity 的非章文件保持 scanDir 原相对序
        let fi = 0
        n.children = n.children.map((c) => (c.isDirectory ? c : files[fi++]!))
      }
    }
    if (n.children.length > 0) sortTreeByOrder(n.children)
  }
}

/** 收集 大纲/卷纲/*.md 的 stem（卷目录关联用）。无该目录 → 空集。
 *  ：① .md 判定改 isMdFileName 单源（大小写不敏感，家族
 *  漏网点）——win 资源管理器手改 .MD 的卷纲此前对卷目录关联静默失明；② stem 以
 *  toNfcName（fs/text-canonical.ts，docJoinKey 同族）NFC 归一为 join 键——
 *  mac APFS 存 NFD、win/NTFS 惯 NFC，NFD 卷目录名 ↔ NFC 卷纲文件名（或反向）
 *  互认。返回 Map：NFC 归一 stem → 盘上原始文件名——关联落 volumeOutlinePath 时
 *  用真实名（NFD/NFC 形态与 .MD 大小写都不硬拼出盘上不存在的路径）。 */
function collectVolumeOutlineStems(bookRoot: string): Map<string, string> {
  const map = new Map<string, string>()
  try {
    for (const f of readdirSync(join(bookRoot, '大纲', '卷纲'))) {
      // isMdFileName 大小写不敏感，但扩展名恒 3 字符——剥尾恒 slice(0, -3)
      if (isMdFileName(f)) map.set(toNfcName(f.slice(0, -3)), f)
    }
  } catch {
    // 无 大纲/卷纲 目录 → 空（短篇 / 旧书）
  }
  return map
}

/** 递归填 docId/status/volumeOutlinePath。：单次读探针（哈希+字数+published 一次带出）。 */
function annotate(
  nodes: TreeNode[],
  bookRoot: string,
  entryByPath: Map<string, ManifestEntry>,
  volumeStems: Map<string, string>,
): void {
  for (const n of nodes) {
    if (!n.isDirectory) {
      const entry = entryByPath.get(docJoinKey(n.path)) // join 键与 set 侧同口径
      n.docId = entry?.id ?? legacyId(n.path)
      // 一次读文件得到 rev + wordCount + published（原 computeRevision/countWordsOf/readPublished 三读合一）
      const probe = probeFile(bookRoot, n.path)
      const rev = probe?.rev ?? null
      const status = deriveStatus(n.path, entry ?? null, rev)
      n.status = status === 'final' && probe?.published ? 'published' : status
      if (isCountedRole(n.role)) {
        n.wordCount = probe?.wordCount ?? 0
        // （阶段 24）：显示排序键带出（正文/短篇角色；probe miss 回落文件名章号）
        if (probe?.order != null) n.order = probe.order
      }
    } else {
      const volName = matchVolumeName(n.path)
      // 两侧 NFC 归一后比对——matchVolumeName 产出的卷名与
      // collectVolumeOutlineStems 登记的 stem 各自 toNfcName 后 join（NFD 卷目录 ↔
      // NFC 卷纲互认）；命中取盘上原始文件名构造关联 path，而非 volName+'.md' 硬拼
      //（NFD/NFC、.MD 大小写形态下硬拼会指向不存在的路径）。
      if (volName) {
        const hit = volumeStems.get(toNfcName(volName))
        if (hit !== undefined) n.volumeOutlinePath = `大纲/卷纲/${hit}`
      }
    }
    if (n.children.length > 0) {
      annotate(n.children, bookRoot, entryByPath, volumeStems)
    }
  }
}

/** 字数统计的正文角色：长篇正文 chapter / 短篇正文 piece-body。
 *  注释如实化：draft 从未计入（工作区/ 在树外）；且 roleOf 现产
 *  只出 'chapter'（layout.ts 口径注记），'piece-body'/'draft' 为预留枚举位。 */
function isCountedRole(role: DocumentRole): boolean {
  return role === 'chapter' || role === 'piece-body'
}

// ── ：树单次读 + 哈希缓存 ─────────────────────────────

/** 单文件探测结果：一次 readFileSync 同时得到哈希 + 字数 + 已发布标志 + 显示序（原三读合一，阶段 24 增 order）。 */
interface FileProbe {
  rev: `sha256:${string}`
  wordCount: number
  published: boolean
  /** fm `序` 显示排序键；无键/非法值 → null（排序回落文件名章号）。 */
  order: number | null
}

/**
 * 进程级哈希缓存：path + (mtimeNs,size) → probe。
 * 文件未变（stat 级检测）→ 复用，跳过整文件读 + SHA-256（200 万字树的重灾区）。
 * 低级项：①缓存加上限（FIFO 淘汰，Map 保插入序）——键带 bookRoot 但长期
 * 运行的桌面进程逐书累积无界；上限取单书树规模（200 万字书 ≈ 千级文件）的 4 倍余量。
 * ②指纹 mtimeMs → bigint stat 的 mtimeNs——同 ms 内改回同长内容的撞车窗口收窄到 ns 级。
 */
const PROBE_CACHE_MAX = 4096
const probeCache = new Map<string, { mtimeNs: bigint; size: bigint; probe: FileProbe }>()

/**
 * 字节指纹的缓存版（computeRevision 语义，stat 级复用 probeCache）。
 * 树红点聚合每章一调——未变文件（绝大多数）stat 命中零读零哈希，替代每章整读 + SHA-256；
 * 结构性 mutation 时随 invalidateTreeIndex 一并失效。mtime+size 撞车理论窗口与树自身
 * probeCache 同口径。文件不存在/读失败 → null（调用方容错）。
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
  // probe 的调用方传 manifest 登记路径——过 safeManifestPath
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
  let order: number | null = null
  if (split) {
    published = parsePublishedValue(split.fmRaw)
    // （阶段 24）：`序` 与 `已发布` 同式同源（chapters.ts 归一小函数，regex 捕获串
    // 直传——成对引号在 parseOrderOf 内剥），复用已读字节零额外读。
    // 0914 捕获值先剥行内注释（`序: 3 # 备注` 此前 Number 强转失败
    // 落缺省，readChapter 侧 parseFlat 先剥注释判得 3，两链路口径分裂）
    const om = split.fmRaw.match(/^序[:：]\s*(.+?)\s*$/m)
    if (om) order = parseOrderOf(stripInlineComment(om[1]!.trim())) ?? null
  }
  const probe: FileProbe = { rev, wordCount, published, order }
  // FIFO 淘汰最旧（Map 保插入序）
  if (probeCache.size >= PROBE_CACHE_MAX) {
    const oldest = probeCache.keys().next().value
    if (oldest !== undefined) probeCache.delete(oldest)
  }
  probeCache.set(key, { mtimeNs: st.mtimeNs, size: st.size, probe })
  return probe
}

/** 从 fm 原文提取 `已发布` 判定（probe 热路径：fm 原文单次读取复用，零额外 IO，只加
 *  纯函数处理）。-0914 值侧处理对齐 status.readPublished 的 parseFlat
 *  单源口径——捕获值先 stripInlineComment 剥行内注释（`已发布: true # 备注` 此前把
 *  「true # 备注」整段当值判 false，树/定稿两链路分裂），再走 parseValue（内联数组
 *  `['true']` 形态与引号配对 unquote 均与 parseFlat 同源），终判 chapters.isPublishedValue
 *  单源（含数组形态）。原注「与 readPublished/parseFlat 同口径」失实（不剥注释、
 *  不认数组、引号配对剥除自实现），随批更正。 */
function parsePublishedValue(fmRaw: string): boolean {
  const m = fmRaw.match(/^已发布[:：]\s*(.+?)\s*$/m)
  if (!m) return false
  return isPublishedValue(parseValue(stripInlineComment(m[1]!.trim())))
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

/** indexes 条目的上次 JSON 序列化串（bookRoot → string）——force
 *  重建的「未变化不 bump」等价比较此前每次对 prev.nodes 与新 nodes 各整树 stringify
 *  一遍（双串对比），窗口回前台 2s 节流 force 轮询反复支付两份千章树序列化；
 *  改存上次结果后热路径只 stringify 新 nodes 一份与缓存串比对。不变量：缓存串（若在）
 *  === stringify(indexes.get(bookRoot).nodes)——invalidateTreeIndex 删索引条目时同步
 *  删（残留陈串会在「磁盘改回旧形态」时误判未变化，返回旧 nodes 的 index）；FIFO
 *  淘汰同步删。冷缓存（fresh 构建不预付序列化，保持 「仅 force 路径付出」纪律）
 *  首次 force 付一次种子串（与旧双串等价），此后恒单串。内存≈树序列化串 ×16 书上限，
 *  与 indexes 条目本体同量级。 */
const indexSigCache = new Map<string, string>()

/** 内存闸：树索引按 bookRoot 缓存整树、无上限——长跑桌面/服务进程
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
  // force 重建内容不变则不 bump revision——窗口回前台拉全树
  //（ChapterTreePanel 2s 节流 force）此前必 ++globalRevision，前端 doc store
  // syncCleanWithTree 按 revision 判 stale → 全部 clean 文档缓存（上限 20）全量重拉
  //（20 次 GET /file + sha256），「写作中频繁切窗查资料」场景对账永不收敛。结构化
  // 变更（增删改/改名）走 invalidateTreeIndex 删缓存，重建必不等 → revision 照常
  // 递增；外部编辑改动节点 mtime/size/摘要 → 序列化不等 → 照常递增。等价比较用
  // JSON 序列化（同构建路径键序稳定；键序漂移只会退回「视为变更」旧行为，安全侧）；
  // 千章树毫秒级，仅 force 路径付出。
  // 双整树 stringify 改缓存串对比——只序列化新 nodes 一份，
  // 与 indexSigCache 存的上次串比对（冷缓存首 force 付一次 prev 侧种子串，与旧双串
  // 等价）；相等沿用 prev（不 bump），不等则以新串更新缓存（见顶部 indexSigCache
  // 不变量注释）。
  const prev = indexes.get(bookRoot)
  if (prev) {
    const newSig = JSON.stringify(nodes)
    let prevSig = indexSigCache.get(bookRoot)
    if (prevSig === undefined) {
      prevSig = JSON.stringify(prev.nodes)
      indexSigCache.set(bookRoot, prevSig)
    }
    if (prevSig === newSig) {
      prev.validatedAt = new Date().toISOString()
      return prev
    }
    indexSigCache.set(bookRoot, newSig)
  }
  const index: BookTreeIndex = {
    bookRoot,
    nodes,
    revision: ++globalRevision,
    validatedAt: new Date().toISOString(),
  }
  // FIFO 淘汰最旧（Map 保插入序，与 probeCache 同口径）；：sig 缓存随条目同步
  // 淘汰（保「缓存串 ⇔ indexes 条目」不变量，防他书陈串残留）
  if (indexes.size >= INDEXES_CACHE_MAX) {
    const oldest = indexes.keys().next().value
    if (oldest !== undefined) {
      indexes.delete(oldest)
      indexSigCache.delete(oldest)
    }
  }
  indexes.set(bookRoot, index)
  return index
}

/**
 * 结构性 mutation 后失效缓存（下次 getBookTreeIndex 重建，revision 递增）。
 *
 * structural=true：改名/移动/删章/书改名等改变 rel_path 集合的 mutation
 * ——树红点缓存表按 rel_path 键控，旧行成垃圾，整表清空回收（残留不致错——
 * 新路径必 miss——只是防膨胀）。内容保存（draft-pipeline/files）不传：章级
 * (mtime,size) 指纹自会失效对应行，整表连坐会把「改 1 章只重查 1 章」打回全书。
 *
 * 内容保存路径（能定位改动文件者）改走 invalidateTreeIndexForContent
 * （probeCache 单键失效）——本函数的整书 probeCache 清理保留给结构性 mutation 与无法
 * 定位改动文件的调用面（finalize 等）。
 */
export function invalidateTreeIndex(bookRoot: string, structural = false): void {
  indexes.delete(bookRoot)
  // 序列化串缓存随索引条目同步删——条目已删而陈串残留时，磁盘
  // 改回旧形态会让 force 对比误命中（返回旧 nodes 的 prev，不 bump 且不重建），见
  // 顶部 indexSigCache 不变量注释。
  indexSigCache.delete(bookRoot)
  // 文件内容可能已变（保存/回滚/定稿）→ 哈希缓存一并失效，防 mtime 撞车后复用旧哈希。
  // 按书前缀清理（缓存键本就带 bookRoot）——此前 clearProbeCache 全局清空，
  // 任一书保存会让其他书首次树聚合退化为全量读（多书同开时的无谓读放大）
  const prefix = bookRoot + '|'
  for (const key of probeCache.keys()) {
    if (key.startsWith(prefix)) probeCache.delete(key)
  }
  if (structural) clearTreeIssuesCacheForBook(bookRoot)
}

/**
 * 内容保存的单键失效——indexes 照常整书重建（树 wordCount/status
 * 投影要刷新），但 probeCache 只删本次改写文件的键。此前内容保存走 invalidateTreeIndex
 * 把该书 probeCache 整书清空，下一次树请求（前台 2s 节流 force）对全书 md 文件重读+
 * 重哈希（200 万字书 100-300ms/次，网盘卷秒级）——而其余文件的 (mtimeNs,size) 指纹
 * 未变、复用安全，的防撞车口径只对本次改写文件必要。新文件落盘时键本不存在，
 * delete 为 no-op（indexes.delete 已保证树重建收编新文件）。
 */
export function invalidateTreeIndexForContent(bookRoot: string, relPath: string): void {
  indexes.delete(bookRoot)
  // sig 缓存随条目同步删（同 invalidateTreeIndex，不变量见顶部注释）
  indexSigCache.delete(bookRoot)
  probeCache.delete(bookRoot + '|' + relPath)
}
