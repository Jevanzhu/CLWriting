<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore, type CreateKind } from '../../stores/workspace'
import { useWordsStore } from '../../stores/words'
import { useUiStore } from '../../stores/ui'
import type { TreeNode } from '../../types/tree'
import {
  createDoc,
  renameDoc,
  moveDoc,
  copyDoc,
  deleteDoc,
  updateChapterMetaDoc,
  batchFinalizeDocs,
} from '../../api/documents'
import { parseChapterFileName } from '../../shared/words'
import {
  chapterTemplate,
  chapterOutlineTemplate,
  volumeOutlineTemplate,
  characterTemplate,
  itemTemplate,
  foreshadowTemplate,
} from '../../shared/templates'
import ContextMenu, { type MenuItem } from '../ui/ContextMenu.vue'
import { useNativeMenu } from '../../composables/useNativeMenu'
import ChapterTreeItem from './ChapterTreeItem.vue'
import ChapterMetaDialog from './ChapterMetaDialog.vue'
import { friendlyError } from '../../shared/error'

// 章节树面板：GET /tree → groupTree 分组 → 递归渲染 + 六态角标 + 展开态持久化
//   + 右键菜单（五类）+ inline 新建/重命名 + 删除/移动 + 拖拽移动。
// CRUD 逻辑移植旧 FileTree（平价基准）。

const props = defineProps<{ bookName: string }>()
const tree = useTreeStore()
const words = useWordsStore()
const doc = useDocStore()
const ws = useWorkspaceStore()
const ui = useUiStore()

const expanded = computed<Set<string>>(() => new Set(ws.treeExpanded))
const openError = ref<string | null>(null)

const activePath = computed<string | null>(
  () => (ws.activeDocId ? doc.get(ws.activeDocId)?.path ?? null : null),
)

// --- 菜单状态 ---
const menuNode = ref<TreeNode | null>(null)
const { isNative, menuVisible, menuX, menuY, menuItems, popup, onPopupSelect, onPopupClose } = useNativeMenu()
/** 桌面版才有「打开所在文件夹」（Electron shell.showItemInFolder 跨平台；浏览器版隐藏） */
const hasShowInFolder = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop?.showInFolder)

// --- inline 新建/重命名 ---
type Creating = {
  kind: 'chapter' | 'chapter-outline' | 'volume-outline' | 'character' | 'item' | 'foreshadow' | 'volume' | 'doc'
  renderDir: string
  fsDir: string
  seed: string
} | null
const creating = ref<Creating>(null)
const renamePath = ref<string | null>(null)
// 块2.2 篇章信息弹窗：编辑 标题 + 章号（落 fm + 路径同步 rename；长篇改文件名 / 短篇改文件名）
// isPiece 标记短篇正文（3 位补零）
const metaEditing = ref<{
  docId: string
  标题: string
  num: number | null
  isPiece: boolean
} | null>(null)

// --- 拖拽 ---
const draggedPath = ref<string | null>(null)


function toggle(path: string): void {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  ws.treeExpanded = [...next]
}

async function onSelect(node: TreeNode): Promise<void> {
  if (node.isDirectory || !node.docId) return
  openError.value = null
  try {
    await doc.open(node)
    ws.openTab(node.docId)
  } catch (e) {
    openError.value = friendlyError(e)
  }
}

// --- 名称校验（移植旧 FileTree.sanitizeName）---
function sanitizeName(value: string): string | null {
  const v = value.trim()
  if (!v || /[\/\\]/.test(v) || v.startsWith('.') || /[\x00-\x1f]/.test(v)) return null
  return v
}

// --- 卷/章号辅助（移植旧 FileTree）---
function isVolumeDir(p: string): boolean {
  const prefix = '写作/正文/'
  if (!p.startsWith(prefix)) return false
  const rest = p.slice(prefix.length)
  return rest !== '' && !rest.includes('/')
}
function extractChapterNo(name: string): number | null {
  const m = name.match(/^(?:第)?(\d+)(?:章)?-/) ?? name.match(/第(\d+)章/)
  return m ? Number(m[1]) : null
}
function nextChapterNo(): number {
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
  walk(tree.grouped)
  return max + 1
}
/** 正文根目录节点（v2：写作/正文）。 */
function writeRoot(): TreeNode | undefined {
  const writeGroup = tree.grouped.find((n) => n.path === '写作')
  return writeGroup?.children.find((c) => c.path === '写作/正文')
}
function lastVolumePath(): string | null {
  const vols = (writeRoot()?.children ?? []).filter((n) => n.isDirectory && isVolumeDir(n.path))
  return vols.length ? (vols[vols.length - 1]?.path ?? null) : null
}
/** 正文现有卷数（用于卷纲编号推断：N = 卷数 + 1）。 */
function volumeCount(): number {
  return (writeRoot()?.children ?? []).filter((n) => n.isDirectory && isVolumeDir(n.path)).length
}
function collectAncestors(ns: TreeNode[], target: string, acc: string[] = []): string[] | null {
  for (const n of ns) {
    if (n.path === target) return acc
    if (n.isDirectory && n.children.length) {
      const r = collectAncestors(n.children, target, [...acc, n.path])
      if (r) return r
    }
  }
  return null
}
function moveToTargets(node: TreeNode): { label: string; dir: string }[] {
  const parent = node.path.slice(0, node.path.lastIndexOf('/'))
  const targets: { label: string; dir: string }[] = [{ label: '正文根', dir: '写作/正文' }]
  for (const v of (writeRoot()?.children ?? []).filter((n) => n.isDirectory && isVolumeDir(n.path))) {
    targets.push({ label: v.name, dir: v.path })
  }
  return targets.filter((t) => t.dir !== parent)
}

// --- 菜单生成（五类，移植旧 FileTree.buildMenuItems）---
/** 正文区新建选项（卷/章节）—— label 带「新建」自解释，直接摊开不分层 */
const NEW_BODY: MenuItem[] = [
  { key: 'new-volume', label: '新建卷' },
  { key: 'new-chapter-root', label: '新建章节' },
]
/** 大纲区新建选项（章纲/卷纲/总纲） */
const NEW_OUTLINE: MenuItem[] = [
  { key: 'new-chapter-outline', label: '新建章纲' },
  { key: 'new-volume-outline', label: '新建卷纲' },
  { key: 'new-synopsis', label: '新建总纲' },
]
/** 设定区新建选项（角色/物品/世界观/伏笔） */
const NEW_SETTINGS: MenuItem[] = [
  { key: 'new-character', label: '新建角色' },
  { key: 'new-item', label: '新建物品' },
  { key: 'new-worldview', label: '新建世界观' },
  { key: 'new-foreshadow', label: '新建伏笔' },
]
/** 空白处全量新建选项（正文/大纲/设定三组用分隔线隔开，不搞子菜单嵌套） */
const NEW_BLANK: MenuItem[] = [
  ...NEW_BODY,
  { key: 'sep-1', label: '', separator: true },
  ...NEW_OUTLINE,
  { key: 'sep-2', label: '', separator: true },
  ...NEW_SETTINGS,
]

/** 目录右键菜单：新建项在前，文件操作（打开所在文件夹）分隔线隔开在后（桌面版）。 */
function dirMenu(items: MenuItem[]): MenuItem[] {
  if (!hasShowInFolder) return items
  return [...items, { key: 'sep-reveal', label: '', separator: true }, { key: 'reveal-in-folder', label: '打开所在文件夹' }]
}

function buildMenuItems(node: TreeNode): MenuItem[] {
  const p = node.path
  // 正文区/大纲区/设定区：新建项直接摊开在顶层（不包「新建 ▸」子菜单——选项少，多一级是噪音）
  if (node.isDirectory && isVolumeDir(p)) {
    return dirMenu([{ key: 'new-chapter', label: '新建章节' }])
  }
  if (p === '写作/正文' || p === '写作') {
    return dirMenu(NEW_BODY)
  }
  // 大纲根：章纲/卷纲/总纲（单例总纲只在根/空白处提供，不进具体子目录）
  if (node.isDirectory && p === '大纲') {
    return dirMenu(NEW_OUTLINE)
  }
  if (node.isDirectory && p === '大纲/章纲') {
    return dirMenu([{ key: 'new-chapter-outline', label: '新建章纲' }])
  }
  if (node.isDirectory && p === '大纲/卷纲') {
    return dirMenu([{ key: 'new-volume-outline', label: '新建卷纲' }])
  }
  // 设定根：角色/物品/世界观/伏笔（单例世界观只在根/空白处提供）
  if (node.isDirectory && p === '设定') {
    return dirMenu(NEW_SETTINGS)
  }
  if (node.isDirectory && p === '设定/角色') {
    return dirMenu([{ key: 'new-character', label: '新建角色' }])
  }
  if (node.isDirectory && p === '设定/物品') {
    return dirMenu([{ key: 'new-item', label: '新建物品' }])
  }
  if (node.isDirectory && p === '设定/伏笔') {
    return dirMenu([{ key: 'new-foreshadow', label: '新建伏笔' }])
  }
  if (node.isDirectory && (p.startsWith('大纲/') || p.startsWith('设定/'))) {
    return dirMenu([{ key: 'new-doc', label: '新建文档' }])
  }
  if (!node.isDirectory) return buildLeafMenu(node)
  return []
}
function buildLeafMenu(node: TreeNode): MenuItem[] {
  const items: MenuItem[] = [{ key: 'rename', label: '重命名' }]
  if (node.role === 'piece-body') {
    // 短篇正文：标题/篇号编辑（联动文件名）；无跨卷移动（短篇集扁平；path 与长篇同为 写作/正文/）
    items.push({ key: 'meta', label: '篇章信息…' })
    // 定稿：正文区 draft（首次）/ revision（改动后）可定稿；final 已定稿不显
    if (node.status === 'draft' || node.status === 'revision') {
      items.push({ key: 'finalize', label: '定稿' })
    }
  } else if (node.path.startsWith('写作/正文/')) {
    items.push({ key: 'meta', label: '章节信息…' })
    // 定稿：正文区 draft（首次）/ revision（改动后）可定稿；final 已定稿不显
    if (node.status === 'draft' || node.status === 'revision') {
      items.push({ key: 'finalize', label: '定稿' })
      // 批量定稿到此章：仅当存在更早的待定稿章（自己 + 之前的所有 draft/revision）才有意义
      if (pendingChaptersUpTo(node).length > 1) {
        items.push({ key: 'batch-finalize', label: '批量定稿到此章' })
      }
    }
    const targets = moveToTargets(node)
    if (targets.length) {
      items.push({
        key: 'move',
        label: '移动到…',
        submenu: targets.map((t) => ({ key: `move:${t.dir}`, label: t.label })),
      })
    }
    items.push({ key: 'copy', label: '创建副本' })
  }
  items.push({ key: 'sep-a', label: '', separator: true })
  // 桌面版在系统文件管理器中显示文件所在文件夹（浏览器版无此 API 隐藏）
  if (hasShowInFolder) {
    items.push({ key: 'reveal-in-folder', label: '打开所在文件夹' })
  }
  items.push({ key: 'copy-path', label: '复制路径' })
  items.push({ key: 'sep-b', label: '', separator: true })
  items.push({ key: 'delete', label: '删除', danger: true })
  return items
}

/**
 * 收集「≤ 目标章号」的所有待定稿正文章（draft/revision）。
 * 从整树 raw 扫（含短篇 piece-body，扁平无卷——章号从文件名取）。
 * 返回 docId 列表（含目标章自身，按章号升序）。
 * 注意：TreeNode.path 是完整相对路径（写作/正文/N-标题.md），章号只能从 name 提取。
 */
function pendingChaptersUpTo(target: TreeNode): string[] {
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
  walk(tree.raw)
  return out.sort((a, b) => a.no - b.no).map((x) => x.docId)
}

function onContextMenu(node: TreeNode, x: number, y: number): void {
  const items = buildMenuItems(node)
  if (!items.length) return
  menuNode.value = node
  popup(items, x, y, onMenuSelect)
}
function onBlankContextMenu(e: MouseEvent): void {
  // 节点项 contextmenu 冒泡到此：节点 handler 已设对应菜单，跳过避免被空白菜单覆盖
  if ((e.target as HTMLElement).closest('.tree-item')) return
  e.preventDefault()
  menuNode.value = null
  // 空白处 = 「还没想好建在哪」：8 种新建选项直接摊开在顶层（NEW_BLANK 已按正文/大纲/设定三组分隔），
  // 不缩进「新建」子菜单——空白处就一个动作，多一级点击是噪音
  popup(NEW_BLANK, e.clientX, e.clientY, onMenuSelect)
}

// --- 菜单动作分发 ---
/** 新建类 key → 标准落盘目录（空白处 / 找不到右键目录时用）。正文/卷原地建不在此表（依赖右键目标或正文区惯例）。 */
const NEW_DEFAULT_DIRS: Record<string, { renderDir: string; fsDir: string }> = {
  'new-chapter-outline': { renderDir: '大纲', fsDir: '大纲/章纲' },
  'new-volume-outline': { renderDir: '大纲', fsDir: '大纲/卷纲' },
  'new-character': { renderDir: '设定', fsDir: '设定/角色' },
  'new-item': { renderDir: '设定', fsDir: '设定/物品' },
  'new-foreshadow': { renderDir: '设定', fsDir: '设定/伏笔' },
}
/** 新建类 key → startCreate kind（与 NEW_* 菜单常量的 key 一一对应）。 */
const NEW_KIND_BY_KEY: Record<string, 'chapter-outline' | 'volume-outline' | 'character' | 'item' | 'foreshadow'> = {
  'new-chapter-outline': 'chapter-outline',
  'new-volume-outline': 'volume-outline',
  'new-character': 'character',
  'new-item': 'item',
  'new-foreshadow': 'foreshadow',
}

function onMenuSelect(key: string): void {
  // ── 不依赖右键目标的动作（空白处/节点右键均可触发）──
  if (key === 'new-volume') return startCreate('volume', '写作', '写作/正文')
  if (key === 'new-chapter-root') {
    const vol = lastVolumePath()
    return startCreate('chapter', vol ?? '写作', vol ?? '写作/正文')
  }
  if (key === 'new-synopsis') return void createSingleton('大纲/总纲.md', '总纲')
  if (key === 'new-worldview') return void createSingleton('设定/世界观.md', '世界观')
  // 章纲/卷纲/角色/物品/伏笔：子目录右键就地建；空白处落到标准目录（对齐 dispatchCreate）
  const def = NEW_DEFAULT_DIRS[key]
  if (def) {
    const kind = NEW_KIND_BY_KEY[key]!
    const node = menuNode.value
    if (node && node.isDirectory && !node.path.startsWith('写作/')) {
      // 子目录右键：章纲/卷纲在大纲根落标准子目录，其余就地建
      const fsDir =
        key === 'new-chapter-outline' || key === 'new-volume-outline'
          ? node.path === '大纲'
            ? def.fsDir
            : node.path
          : node.path
      return startCreate(kind, node.path, fsDir)
    }
    return startCreate(kind, def.renderDir, def.fsDir)
  }
  if (key.startsWith('move:')) {
    const node = menuNode.value
    if (node?.docId) void doMove(node.docId, key.slice('move:'.length))
    return
  }
  const node = menuNode.value
  if (!node) return
  if (key === 'new-chapter') startCreate('chapter', node.path, node.path)
  else if (key === 'new-doc') startCreate('doc', node.path, node.path)
  else if (key === 'rename') renamePath.value = node.path
  else if (key === 'finalize') {
    if (node.docId) void doc.finalize(node.docId)
  }
  else if (key === 'batch-finalize') {
    const docIds = pendingChaptersUpTo(node)
    if (docIds.length) void doBatchFinalize(docIds)
  }
  else if (key === 'meta') {
    const isPiece = node.role === 'piece-body'
    // 短篇/长篇均从文件名提取编号+标题（短篇 写作/正文/N-标题.md，长篇 写作/正文/[卷/]N-标题.md）
    // 注意：TreeNode.path 是完整相对路径（写作/正文/N-标题.md），章号只能从 name 提取（与 pendingChaptersUpTo 一致）
    const m = parseChapterFileName(node.name)
    metaEditing.value = {
      docId: node.docId ?? '',
      标题: m?.标题 ?? node.name,
      num: m?.章号 ?? null,
      isPiece,
    }
  } else if (key === 'copy') void doCopy(node)
  else if (key === 'copy-path') void onCopyPath(node)
  else if (key === 'reveal-in-folder') void onRevealInFolder(node)
  else if (key === 'delete') void doDelete(node)
}

/** 批量定稿：逐个 finalizeRevision（后端串行，无锁冲突）→ 汇总 toast + 刷树。 */
async function doBatchFinalize(docIds: string[]): Promise<void> {
  const bookName = props.bookName
  try {
    const r = await batchFinalizeDocs(bookName, docIds)
    const done = r.results.filter((x) => x.ok && !x.skipped).length
    const skipped = r.results.filter((x) => x.ok && x.skipped).length
    const failed = r.results.filter((x) => !x.ok).length
    const total = r.results.length
    ui.toast(`已定稿 ${done}/${total} 章${skipped ? `（${skipped} 章已定稿）` : ''}${failed ? `，${failed} 章失败` : ''}`, failed ? 'error' : 'success')
    void tree.load(bookName, true)
  } catch (err) {
    ui.toast(friendlyError(err), 'error')
  }
}

/** 桌面版：在系统文件管理器中打开文件所在文件夹（shell.showItemInFolder 跨平台，传入 node.path）。 */
async function onRevealInFolder(node: TreeNode): Promise<void> {
  const show = window.clwritingDesktop?.showInFolder
  if (!show) return
  try {
    await show(props.bookName, node.path)
  } catch {
    /* 桌面 IPC 异常静默 */
  }
}

async function onCopyPath(node: TreeNode): Promise<void> {
  try {
    await navigator.clipboard.writeText(node.path)
  } catch {
    /* 浏览器限制静默 */
  }
}

// --- 篇章信息（块2.2）---
// 长/短篇统一用「章号」（后端一律落 fm 章号 + 路径 rename）
async function onSaveMeta(meta: { 标题: string; num: number }): Promise<void> {
  const e = metaEditing.value
  if (!e) return
  metaEditing.value = null
  try {
    await updateChapterMetaDoc(props.bookName, e.docId, { 标题: meta.标题, 章号: meta.num })
    await tree.load(props.bookName)
    // 路径可能变（长篇/短篇文件名）→ 同步 doc entry.path
    const entry = doc.get(e.docId)
    if (entry) {
      const fresh = tree.byDocId.get(e.docId)
      if (fresh) entry.path = fresh.path
    }
  } catch (err) {
    openError.value = friendlyError(err)
  }
}

// --- 新建 ---
function onNewChapter(): void {
  const vol = lastVolumePath()
  startCreate('chapter', vol ?? '写作', vol ?? '写作/正文')
}
/** 单文件类型（总纲/世界观）：固定路径，检测存在性，不走 inline 命名。 */
async function createSingleton(relPath: string, label: string): Promise<void> {
  const existing = tree.byPath.get(relPath)
  if (existing?.docId) {
    await doc.open(existing)
    ws.openTab(existing.docId)
    ui.toast(`${label}已存在，已为你打开`, 'info')
    return
  }
  try {
    await createDoc(props.bookName, { relPath })
    await tree.load(props.bookName)
    const fresh = tree.byPath.get(relPath)
    if (fresh?.docId) {
      await doc.open(fresh)
      ws.openTab(fresh.docId)
    }
  } catch (e) {
    openError.value = friendlyError(e)
  }
}
/** TabBar 新建信号分派（按 createKind 路由到 startCreate / createSingleton）。 */
function dispatchCreate(kind: CreateKind): void {
  switch (kind) {
    case 'chapter':
      return onNewChapter()
    case 'chapter-outline':
      return startCreate('chapter-outline', '大纲', '大纲/章纲')
    case 'volume-outline':
      return startCreate('volume-outline', '大纲', '大纲/卷纲')
    case 'character':
      return startCreate('character', '设定', '设定/角色')
    case 'item':
      return startCreate('item', '设定', '设定/物品')
    case 'foreshadow':
      return startCreate('foreshadow', '设定', '设定/伏笔')
    case 'synopsis':
      return void createSingleton('大纲/总纲.md', '总纲')
    case 'worldview':
      return void createSingleton('设定/世界观.md', '世界观')
  }
}
function startCreate(
  kind: 'chapter' | 'chapter-outline' | 'volume-outline' | 'character' | 'item' | 'foreshadow' | 'volume' | 'doc',
  renderDir: string,
  fsDir: string,
): void {
  const ancestors = collectAncestors(tree.grouped, renderDir)
  if (!ancestors && !tree.grouped.some((n) => n.path === renderDir)) {
    openError.value = '当前书库无该区域，无法在此新建'
    return
  }
  const seed =
    kind === 'chapter' || kind === 'chapter-outline'
      ? `${nextChapterNo()}-未命名`
      : kind === 'volume-outline'
        ? `卷纲_第${volumeCount() + 1}卷`
        : ''
  creating.value = { kind, renderDir, fsDir, seed }
  const next = new Set(expanded.value)
  next.add(renderDir)
  if (ancestors) for (const a of ancestors) next.add(a)
  ws.treeExpanded = [...next]
}
async function onCreateCommit(value: string): Promise<void> {
  const c = creating.value
  if (!c) return
  const name = sanitizeName(value)
  if (!name) {
    openError.value = '名称不能为空，或含 / \\ 或以 . 开头'
    return
  }
  creating.value = null
  const relPath =
    c.kind === 'volume'
      ? `${c.fsDir}/${name}/${nextChapterNo()}-未命名.md`
      : `${c.fsDir}/${name}.md`
  // 按类型给初始模板（C5，降低空白页阻力）；volume=建卷即建首章，首章空正文即可
  const content = buildCreateContent(c.kind, name, c.seed, relPath)
  try {
    const r = await createDoc(props.bookName, { relPath, ...(content ? { content } : {}) })
    await tree.load(props.bookName)
    const fresh = tree.byPath.get(r.path)
    if (fresh?.docId) {
      await doc.open(fresh)
      ws.openTab(fresh.docId)
    }
  } catch (e) {
    openError.value = friendlyError(e)
  }
}

/** 按新建类型组装初始模板内容（无模板类型返回 undefined → 后端默认空 front matter）。 */
function buildCreateContent(
  kind: Exclude<Creating, null>['kind'],
  name: string,
  seed: string,
  _relPath: string,
): string | undefined {
  switch (kind) {
    case 'chapter': {
      const no = extractChapterNo(`${nextChapterNo()}-${name}`) ?? extractChapterNo(seed) ?? 1
      return chapterTemplate(no, name)
    }
    case 'chapter-outline': {
      const no = extractChapterNo(seed) ?? 1
      return chapterOutlineTemplate(no, name)
    }
    case 'volume-outline': {
      const m = seed.match(/第(\d+)卷/)
      const vol = m ? Number(m[1]) : volumeCount() + 1
      return volumeOutlineTemplate(vol)
    }
    case 'character':
      return characterTemplate(name)
    case 'item':
      return itemTemplate(name)
    case 'foreshadow':
      return foreshadowTemplate(nextChapterNo())
    // volume / doc：建卷自带首章（空正文）；通用文档无模板
    default:
      return undefined
  }
}
function onCreateCancel(): void {
  creating.value = null
}

// --- 重命名 ---
async function onRenameCommit(path: string, value: string): Promise<void> {
  // 守卫：Enter 提交后设 renamePath=null → input 卸载触发 blur 二次 emit，此时跳过防重复 renameDoc API
  if (renamePath.value !== path) return
  const name = sanitizeName(value)
  if (!name) {
    renamePath.value = null
    return
  }
  renamePath.value = null
  const node = tree.byPath.get(path)
  if (!node?.docId) return
  try {
    await renameDoc(props.bookName, node.docId, `${name}.md`)
    await tree.load(props.bookName)
  } catch (e) {
    openError.value = friendlyError(e)
  }
}
function onRenameCancel(): void {
  renamePath.value = null
}

// --- 删除 ---
async function doDelete(node: TreeNode): Promise<void> {
  if (!node.docId) return
  const ok = await ui.ask({
    title: '删除章节',
    message: `确认删除「${node.name}」？可从回收站恢复。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await deleteDoc(props.bookName, node.docId)
    await tree.load(props.bookName)
  } catch (e) {
    openError.value = friendlyError(e)
  }
}

// --- 移动（菜单 + 拖拽共用）---
async function doMove(docId: string, toDir: string): Promise<void> {
  try {
    await moveDoc(props.bookName, docId, toDir)
    await tree.load(props.bookName)
  } catch (e) {
    openError.value = friendlyError(e)
  }
}
async function onDrop(targetPath: string): Promise<void> {
  const src = draggedPath.value
  draggedPath.value = null
  if (!src) return
  const node = tree.byPath.get(src)
  if (!node?.docId) return
  await doMove(node.docId, targetPath)
}

// --- 复制（E3.3：新章号 + 「副本」标题；后端复制内容到新 path）---
async function doCopy(node: TreeNode): Promise<void> {
  if (!node.docId) return
  // 同 meta：章号/标题从 name 提取（path 是完整相对路径）
  const parsed = parseChapterFileName(node.name)
  const title = parsed?.标题 ?? node.name
  const no = String(nextChapterNo()).padStart(4, '0')
  const relPath = `写作/正文/${no}-${title} 副本.md`
  try {
    const r = await copyDoc(props.bookName, node.docId, relPath)
    await tree.load(props.bookName)
    const fresh = tree.byPath.get(r.path)
    if (fresh?.docId) {
      await doc.open(fresh)
      ws.openTab(fresh.docId)
    }
  } catch (e) {
    openError.value = friendlyError(e)
  }
}

/** 默认展开：一级目录 + 写作/正文（正文是作者主战场，二级也展开） */
function defaultExpandedDirs(nodes: TreeNode[]): string[] {
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

watch(
  () => props.bookName,
  async (name) => {
    if (!name) return
    await tree.load(name, true) // 切书：重扫盘（上次会话期间盘上可能被外部改过）
    // 首次打开（无持久化展开状态）→ 一级目录 + 写作/正文
    if (ws.treeExpanded.length <= 1) {
      ws.treeExpanded = defaultExpandedDirs(tree.grouped)
    }
    // 今日基线：tree.load 后 totalWords 已就绪（§5.4），不阻塞树渲染
    void words.ensureBaseline(name)
  },
  { immediate: true },
)

// 窗口回前台 → 重扫盘。外部编辑器 / CLI / AI 写的文件不经 invalidateTreeIndex，
// 服务端树缓存不会自己失效；切回 app 是「想看到最新状态」的最强信号。
// 节流 2s：避免频繁切窗口时反复触发全盘扫描（buildTree 含 git status + 字数统计）。
let lastRefresh = 0
function onWindowFocus(): void {
  if (!props.bookName) return
  const now = performance.now()
  if (now - lastRefresh < 2000) return
  lastRefresh = now
  void tree.load(props.bookName, true)
}
onMounted(() => window.addEventListener('focus', onWindowFocus))
onUnmounted(() => window.removeEventListener('focus', onWindowFocus))

// TabBar 新建信号 → 监听 createTick 按 createKind 分派（首次 tick=0 不触发，跳过初始）
watch(
  () => ws.createTick,
  (n, old) => {
    if (old !== undefined && n > old) dispatchCreate(ws.createKind)
  },
)
</script>

<template>
  <div class="chapter-tree" @contextmenu="onBlankContextMenu($event)">
    <div v-if="tree.loading" class="hint">加载中…</div>
    <div v-else-if="tree.error" class="hint err">{{ tree.error }}</div>
    <div v-else-if="!tree.grouped.length" class="hint">（无章节）</div>
    <div v-else class="tree-list">
      <ChapterTreeItem
        v-for="n in tree.grouped"
        :key="n.path"
        :node="n"
        :depth="0"
        :expanded="expanded"
        :active-path="activePath"
        :creating-dir-path="creating?.renderDir ?? null"
        :creating-kind="creating?.kind ?? null"
        :creating-seed="creating?.seed ?? ''"
        :rename-path="renamePath"
        :dragged-path="draggedPath"
        @toggle="toggle"
        @select="onSelect"
        @contextmenu="onContextMenu"
        @create-commit="onCreateCommit"
        @create-cancel="onCreateCancel"
        @rename-commit="onRenameCommit"
        @rename-cancel="onRenameCancel"
        @dragstart="draggedPath = $event"
        @dragend="draggedPath = null"
        @drop="onDrop"
      />
    </div>
    <div v-if="openError" class="hint err">{{ openError }}</div>
    <div v-if="tree.grouped.length" class="tree-legend">
      <span class="lg"><i class="lg-dot c-green"></i>定稿</span>
      <span class="lg"><i class="lg-dot c-yellow"></i>草稿</span>
      <span class="lg"><i class="lg-dot c-red"></i>待修</span>
      <span class="lg"><i class="lg-dot c-gray"></i>其他</span>
    </div>
    <ContextMenu
      v-if="!isNative"
      :visible="menuVisible"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @select="onPopupSelect"
      @close="onPopupClose"
    />
    <ChapterMetaDialog
      :model-value="!!metaEditing"
      :num="metaEditing?.num ?? null"
      :标题="metaEditing?.标题 ?? ''"
      :is-piece="metaEditing?.isPiece ?? false"
      @update:model-value="(v: boolean) => { if (!v) metaEditing = null }"
      @save="onSaveMeta"
    />
  </div>
</template>

<style scoped>
.chapter-tree {
  padding: var(--size-4-1) 0 0;
  min-height: 100%;
  display: flex;
  flex-direction: column;
}
.hint {
  padding: 8px var(--size-4-3);
  font-size: var(--font-size-m);
  color: var(--text-faint);
}
.hint.err {
  color: var(--text-error);
}
.tree-list {
  padding: 0 var(--size-4-1);
  flex: 1;
  min-height: 0;
}
/* 色点图例（钉在文件树底部，单行） */
.tree-legend {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: nowrap;
  gap: 12px;
  padding: 4px var(--size-4-2);
  font-size: var(--font-size-xxs);
  letter-spacing: 0.02em;
  color: var(--text-faint);
  border-top: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  white-space: nowrap;
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.lg-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.lg-dot.c-green { background: var(--dv-good); }
.lg-dot.c-yellow { background: var(--text-warning); }
.lg-dot.c-red { background: var(--text-error); }
.lg-dot.c-gray { background: var(--text-faint); }
</style>
