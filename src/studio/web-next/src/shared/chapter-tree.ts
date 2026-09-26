/**
 * 章节树纯工具函数（自 ChapterTreePanel 拆出）。
 *
 * 全部为无副作用纯函数：树形态判定、章号/卷号推断、祖先收集、待定稿收集、
 * 默认展开集。输入 TreeNode[]（tree.grouped 或 tree.raw），不依赖组件与响应式。
 */
import type { TreeNode } from '../types/tree'
import { parseChapterFileName } from './words'

/** Windows 保留设备名（大小写不敏感）：主文件名命中即不可建（CON.md 在 Win 侧同样非法）。
 *  COM1-9 / LPT1-9 为串并口设备名系列；不含 console（普通词，非保留名）。 */
const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

/** 名称校验（原 FileTree.sanitizeName）：空/含路径分隔符/点开头/控制字符 → null。
 * 补 Windows 保留设备名拒收——书库目录可被 Windows 端同步/打开，
 *  保留名文件在 Win 不可建，落盘后跨端同步即失败；匹配主文件名（首个点前段，
 *  与 Win 实际语义对齐）：CON.md / Com1.tar.md 的主文件名均命中。
 * 补尾随点/空格拒收——Win 文件/目录名不得以 . 或空格结尾
 * （创建时被系统静默剥除或直接失败），「新建卷」目录名跨端同步到 Win 失败（
 *  同风险面漏项）。空格侧：上方 trim 已剥 ASCII 尾随空格（即输入容错），本行实际
 *  拦「点结尾」；文案一并提示两种形态。
 * 补拒 Win 文件名非法 ASCII 字符
 *  : " < > | ? *（/ \ 已由上方路径分隔符拒收，九字符集就此补齐）——mac 侧可建、同步到
 * Win 即失败（同风险面收口）。全角冒号等全角形态不在集内、不受影响。 */
export function sanitizeName(value: string): string | null {
  const v = value.trim()
  if (!v || /[\/\\]/.test(v) || v.startsWith('.') || /[\x00-\x1f]/.test(v)) return null
  if (/[. ]$/.test(v)) return null
  // Win 非法字符（只拦 ASCII 集内字符，全角：＂＜＞｜？＊不受影响）
  if (/[:"<>|?*]/.test(v)) return null
  // 保留名比对主文件名段（con.tar.md 的主文件名是 con），小写比对大小写不敏感
  const stem = v.split('.')[0]!.toLowerCase()
  if (WINDOWS_RESERVED_NAMES.has(stem)) return null
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
function writeRootIn(nodes: TreeNode[]): TreeNode | undefined {
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

/** 阶段 24：正文长篇章按树显示序扁平（grouped 已由服务端 sortTreeByOrder 按
 *  fm `序` ?? 章号 排好，深度优先遍历即作者看到的章序；短篇 piece-body 不参与结构
 *  操作——留洞制合并/拆分只对长篇章开放）。 */
export function bodyChaptersInDisplayOrder(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (ns: TreeNode[]): void => {
    for (const n of ns) {
      if (!n.isDirectory && n.docId && n.role !== 'piece-body' && n.path.startsWith('写作/正文/')) out.push(n)
      if (n.children.length) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/** 显示序前一章（「并入上一章」的目标章；非章号−1——插序/跨卷后视觉上的上一章才是
 *  作者心智中的「上一章」，与树面板渲染序一致）。无前章（首章）→ null。 */
export function prevBodyChapterInDisplayOrder(target: TreeNode, grouped: TreeNode[]): TreeNode | null {
  const seq = bodyChaptersInDisplayOrder(grouped)
  const idx = seq.findIndex((n) => n.path === target.path)
  return idx > 0 ? (seq[idx - 1] ?? null) : null
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
