<script setup lang="ts">
// 编辑态左栏：文件树（W2A §10.1，混合模型）。
// GET /tree 取真实磁盘节点 → groupTree 虚拟分组（写作/大纲/设定/摘要/工作区/文风）。
// 正文（定稿/正文/*）走磁盘真实卷/章树；定稿/设定、定稿/摘要 提升为根级「设定」「摘要」；
// 工作区草稿（status=draft）抽到「写作」与正文并列；根级配置文件（book.yaml/AGENTS/...）不挑即过滤。
// 圆点按八态派生（FileTreeNode）；expandedPaths 按书名 localStorage 持久化，默认展开「写作」。
// 点选叶子 → router.push /edit?file=xxx（契约不变，Editor 消费 query.file）。
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import FileTreeNode from './FileTreeNode.vue'
import TreeContextMenu, { type MenuItem } from './TreeContextMenu.vue'
import {
  createDocument,
  renameDocument,
  moveDocument,
  trashDocument,
  listTrashEntries,
  restoreTrashEntry,
  purgeTrashEntry,
  type TrashEntry,
} from '../api/books'

interface TreeNode {
  path: string
  name: string
  isDirectory: boolean
  role: string
  children: TreeNode[]
  docId?: string
  status?: string
  volumeOutlinePath?: string
}

const props = defineProps<{ bookName?: string }>()
const route = useRoute()
const router = useRouter()

const nodes = ref<TreeNode[]>([])
const loading = ref(false)
const error = ref('')
const expanded = ref<Set<string>>(new Set())

const enc = computed(() => (props.bookName ? encodeURIComponent(props.bookName) : ''))
// 当前选中 = 路由 query.file（与 Editor selected 同源）
const current = computed(() => (typeof route.query.file === 'string' ? route.query.file : ''))

/** 展开态按书名独立存；v2 = 分组结构变更后换键，避免旧展开态串扰（首见 → 默认展开「写作」）。 */
const storageKey = computed(() => `clw.filetree.v2.${props.bookName ?? '_'}`)

/** 虚拟分组 transform：真实磁盘节点 → 写作功能分组。
 *  - 写作（虚拟，path='写作'）：定稿/正文 真实卷/章子树 + 工作区草稿（status=draft）
 *  - 大纲：真实根目录 + 摘要（原 定稿/摘要）并入为子目录；总纲置顶
 *  - 设定：原 定稿/设定 提升到根级（path 保留真实，匹配 current）
 *  - 文风：真实根目录原样
 *  工作区不进树（由工作台 mode 管：细纲/草稿/审稿/三审等过程文档；草稿已抽「写作」区）。
 *  根级散落文件（book.yaml/AGENTS.md/.gitignore）不在上述目录 → 自动过滤。 */
function groupTree(raw: TreeNode[]): TreeNode[] {
  const find = (ns: TreeNode[], path: string): TreeNode | undefined => ns.find((n) => n.path === path)
  const child = (parent: TreeNode | undefined, path: string): TreeNode | undefined =>
    parent?.children.find((c) => c.path === path)

  const dingao = find(raw, '定稿')
  const dagang = find(raw, '大纲')
  const work = find(raw, '工作区')
  const style = find(raw, '文风')
  const zhengwen = child(dingao, '定稿/正文')
  const shezhi = child(dingao, '定稿/设定')
  const zhaiyao = child(dingao, '定稿/摘要')

  // 草稿：工作区下 status=draft 的叶子（语义判断，不依赖文件名）——抽到「写作」区，工作区本身不显示
  const drafts = (work?.children ?? []).filter((c) => !c.isDirectory && c.status === 'draft')

  const groups: TreeNode[] = []
  // 1. 写作（虚拟）：正文真实子树 + 草稿（作者主战场，排首位）
  const writeChildren = [...(zhengwen?.children ?? []), ...drafts]
  if (writeChildren.length) {
    groups.push({ path: '写作', name: '写作', isDirectory: true, role: 'note', children: writeChildren })
  }
  // 2. 大纲（真实根目录；总纲置顶 + 摘要次之，其余按原序）
  if (dagang) {
    const zonggang = dagang.children.find((c) => !c.isDirectory && c.name === '总纲')
    const rest = dagang.children.filter((c) => c !== zonggang)
    groups.push({ ...dagang, children: [zonggang, zhaiyao, ...rest].filter(Boolean) as TreeNode[] })
  }
  // 3. 设定（原 定稿/设定 提升到根级）
  if (shezhi) groups.push(shezhi)
  // 4. 文风
  if (style) groups.push(style)
  // 工作区不进树（工作台 mode 管：细纲/草稿/审稿/三审等过程文档；草稿已抽「写作」区）
  return groups
}

/** 默认展开：「写作」区（作者主战场）；其下卷折叠（避免章淹没首屏）。 */
function defaultExpanded(): Set<string> {
  return new Set(['写作'])
}

function loadExpanded(): Set<string> | null {
  try {
    const raw = localStorage.getItem(storageKey.value)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    /* 损坏降级到默认 */
  }
  return null
}

function saveExpanded(set: Set<string>): void {
  try {
    localStorage.setItem(storageKey.value, JSON.stringify([...set]))
  } catch {
    /* localStorage 不可用忽略 */
  }
}

function toggle(path: string): void {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expanded.value = next
  saveExpanded(next)
}

function select(path: string): void {
  router.push({ path: `/books/${enc.value}/edit`, query: { file: path } })
}

// ── 块1：右键上下文菜单 + 新建章节/卷/文档 + 删除 ──────────────

const menuVisible = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuItems = ref<MenuItem[]>([])
const menuNode = ref<TreeNode | null>(null)
/** 正在 inline 重命名的节点 path（null = 无）。 */
const renamePath = ref<string | null>(null)
/** 回收站条目 + 展开态（块1，左栏底部组）。 */
const trashEntries = ref<TrashEntry[]>([])
const trashExpanded = ref(false)
/** 「复制路径」后的闪现提示 + 定时器（连续复制先清旧 timer，防 toast 提前消失）。 */
const copiedMsg = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | null = null

/** 校验文件名段：禁含路径分隔符 / .. / 控制字符（防嵌套与逃逸，前端前置拦截）。 */
function sanitizeName(value: string): string | null {
  const v = value.trim()
  if (!v || /[\/\\]/.test(v) || v.startsWith('.') || /[\x00-\x1f]/.test(v)) return null
  return v
}

/** 收集从根到 target 的渲染祖先目录 path 链（虚拟组如「写作」也算；不含 target）。
 *  就地新建需把祖先一并展开，否则目标节点不渲染、输入框无处显示。 */
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

/** 新建输入态（块1 Obsidian 化）：renderDir=输入框渲染节点 path；fsDir=落盘目录；seed=输入初始值。 */
type Creating = {
  kind: 'chapter' | 'volume' | 'doc'
  renderDir: string
  fsDir: string
  seed: string
} | null
const creating = ref<Creating>(null)

/** 定稿/正文/<卷> → true（卷目录，正文直接子级）。 */
function isVolumeDir(p: string): boolean {
  const prefix = '定稿/正文/'
  if (!p.startsWith(prefix)) return false
  const rest = p.slice(prefix.length)
  return rest !== '' && !rest.includes('/')
}

/** 从章文件名提章号：N-标题 / 第N章-标题 / 第N章 → N。 */
function extractChapterNo(name: string): number | null {
  const m = name.match(/^(?:第)?(\d+)(?:章)?-/) ?? name.match(/第(\d+)章/)
  return m ? Number(m[1]) : null
}

/** 全书下一章号：扫 定稿/正文/ 下所有章 .md 取 max+1。 */
function nextChapterNo(): number {
  let max = 0
  const walk = (ns: TreeNode[]): void => {
    for (const n of ns) {
      if (!n.isDirectory && n.path.startsWith('定稿/正文/')) {
        const no = extractChapterNo(n.name)
        if (no && no > max) max = no
      }
      if (n.children.length) walk(n.children)
    }
  }
  walk(nodes.value)
  return max + 1
}

/** 末卷 path（正文根新建章节的默认落点）；无卷 → null。 */
function lastVolumePath(): string | null {
  const writeGroup = nodes.value.find((n) => n.path === '写作')
  const vols = (writeGroup?.children ?? []).filter((n) => n.isDirectory && isVolumeDir(n.path))
  return vols.length ? vols[vols.length - 1].path : null
}

/** 右键节点 → 生成菜单 + 显示。 */
function onContextMenu(node: TreeNode, x: number, y: number): void {
  const items = buildMenuItems(node)
  if (!items.length) return
  menuNode.value = node
  menuItems.value = items
  menuX.value = x
  menuY.value = y
  menuVisible.value = true
}

/** 按节点类型生成菜单项（Obsidian 式：新建▸子菜单 + 分组；卷改名/删后端不支持→后置）。 */
function buildMenuItems(node: TreeNode): MenuItem[] {
  const p = node.path
  // 卷目录：新建▸章节（卷本身不可改名/删，后端只管叶子）
  if (node.isDirectory && isVolumeDir(p)) {
    return [{ key: 'new', label: '新建', submenu: [{ key: 'new-chapter', label: '章节' }] }]
  }
  // 正文区：新建▸[卷, 章节]（'写作' 虚拟组；'定稿/正文' 防御兜底，groupTree 后通常不进树）
  if (p === '定稿/正文' || p === '写作') {
    return [
      {
        key: 'new',
        label: '新建',
        submenu: [
          { key: 'new-volume', label: '卷' },
          { key: 'new-chapter-root', label: '章节' },
        ],
      },
    ]
  }
  // 大纲 / 设定目录：新建▸文档
  if (node.isDirectory && (p.startsWith('大纲/') || p.startsWith('定稿/设定/'))) {
    return [{ key: 'new', label: '新建', submenu: [{ key: 'new-doc', label: '文档' }] }]
  }
  // 叶子文档：重命名 [+章节移动到▸] / 分隔 / 复制路径 [+Finder] / 分隔 / 删除
  if (!node.isDirectory) return buildLeafMenu(node)
  return []
}

/** 叶子文档通用菜单：重命名 [+章节移动到▸] / ─ / 复制路径 [+Finder] / ─ / 删除。 */
function buildLeafMenu(node: TreeNode): MenuItem[] {
  const items: MenuItem[] = [{ key: 'rename', label: '重命名' }]
  // 正文章节可跨卷移动（章号不变，只改卷归属）
  if (node.path.startsWith('定稿/正文/')) {
    const targets = moveToTargets(node)
    if (targets.length) {
      items.push({
        key: 'move',
        label: '移动到…',
        submenu: targets.map((t) => ({ key: `move:${t.dir}`, label: t.label })),
      })
    }
  }
  items.push({ key: 'sep-a', label: '', separator: true })
  items.push({ key: 'copy-path', label: '复制路径' })
  if (canShowInFinder()) items.push({ key: 'show-in-folder', label: '在 Finder 中显示' })
  items.push({ key: 'sep-b', label: '', separator: true })
  items.push({ key: 'delete', label: '删除', danger: true })
  return items
}

/** 章节可移动目标：正文根 + 各卷，排除当前所在目录（已在的无需移）。 */
function moveToTargets(node: TreeNode): { label: string; dir: string }[] {
  const parent = node.path.slice(0, node.path.lastIndexOf('/'))
  const targets: { label: string; dir: string }[] = [{ label: '正文根', dir: '定稿/正文' }]
  const writeGroup = nodes.value.find((n) => n.path === '写作')
  for (const v of (writeGroup?.children ?? []).filter(
    (n) => n.isDirectory && isVolumeDir(n.path),
  )) {
    targets.push({ label: v.name, dir: v.path })
  }
  return targets.filter((t) => t.dir !== parent)
}

/** electron 暴露了 showInFolder 才显示「在 Finder 中显示」（浏览器版隐藏）。 */
function canShowInFinder(): boolean {
  return !!window.clwritingDesktop?.showInFolder
}

/** 菜单动作分发（new-volume/new-chapter-root 不需 menuNode，空白右键可触发；move: 读 menuNode.docId）。 */
function onMenuSelect(key: string): void {
  // 写作区新建：落点由 lastVolumePath / 写作组决定，不需 menuNode（空白右键 menuNode=null）
  if (key === 'new-volume') return startCreate('volume', '写作', '定稿/正文')
  if (key === 'new-chapter-root') {
    const vol = lastVolumePath()
    return startCreate('chapter', vol ?? '写作', vol ?? '定稿/正文')
  }
  if (key.startsWith('move:')) {
    const node = menuNode.value
    if (node?.docId) void doMoveDocument(node.docId, key.slice('move:'.length))
    return
  }
  const node = menuNode.value
  if (!node) return
  if (key === 'new-chapter') startCreate('chapter', node.path, node.path)
  else if (key === 'new-doc') startCreate('doc', node.path, node.path)
  else if (key === 'rename') renamePath.value = node.path
  else if (key === 'copy-path') void onCopyPath(node)
  else if (key === 'show-in-folder') onShowInFolder(node)
  else if (key === 'delete') void doDelete(node)
}

/** 空白处右键：弹根级新建菜单（落写作区）。 */
function onBlankContextMenu(e: MouseEvent): void {
  e.preventDefault()
  menuNode.value = null
  menuItems.value = [
    {
      key: 'new',
      label: '新建',
      submenu: [
        { key: 'new-volume', label: '卷' },
        { key: 'new-chapter-root', label: '章节' },
      ],
    },
  ]
  menuX.value = e.clientX
  menuY.value = e.clientY
  menuVisible.value = true
}

/** 复制文档相对路径到剪贴板（书仓库内，便于跨机/文档引用）+ 闪现提示（失败也给反馈）。 */
async function onCopyPath(node: TreeNode): Promise<void> {
  if (copiedTimer) clearTimeout(copiedTimer)
  try {
    await navigator.clipboard.writeText(node.path)
    copiedMsg.value = '路径已复制'
  } catch {
    copiedMsg.value = '复制失败（浏览器限制）'
  }
  copiedTimer = setTimeout(() => (copiedMsg.value = ''), 1500)
}

/** 在系统文件管理器中显示（electron shell.showItemInFolder，浏览器版无此项）。 */
function onShowInFolder(node: TreeNode): void {
  void window.clwritingDesktop?.showInFolder?.(props.bookName!, node.path)
}

/** 启动新建（Obsidian 式就地）：算渲染落点 + 落盘目录 + 预填值，并展开目标目录及其渲染祖先
 *  （如卷节点需「写作」组也展开才渲染），否则输入框无处显示。 */
function startCreate(
  kind: 'chapter' | 'volume' | 'doc',
  renderDir: string,
  fsDir: string,
): void {
  // 渲染落点必须在当前树内（含祖先），否则输入框永不显示 → 拒绝并提示
  const ancestors = collectAncestors(nodes.value, renderDir)
  if (!ancestors && !nodes.value.some((n) => n.path === renderDir)) {
    error.value = '当前书库无该区域，无法在此新建'
    return
  }
  const seed = kind === 'chapter' ? `${nextChapterNo()}-未命名` : ''
  creating.value = { kind, renderDir, fsDir, seed }
  const next = new Set(expanded.value)
  next.add(renderDir)
  if (ancestors) for (const a of ancestors) next.add(a)
  expanded.value = next
  saveExpanded(next)
}

/** 就地新建提交（FileTreeNode emit 输入值）：校验名 → POST → 刷新 + 跳编辑器。 */
async function onCreateCommit(value: string): Promise<void> {
  const c = creating.value
  if (!c) return
  const name = sanitizeName(value)
  if (!name) {
    error.value = '名称不能为空，或含 / \\ 或以 . 开头'
    return // 保留 creating，让用户改
  }
  creating.value = null
  const relPath =
    c.kind === 'volume'
      ? `${c.fsDir}/${name}/${nextChapterNo()}-未命名.md`
      : `${c.fsDir}/${name}.md`
  try {
    const r = await createDocument(props.bookName!, { relPath })
    await load()
    router.push({ path: `/books/${enc.value}/edit`, query: { file: r.path } })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** 就地新建取消（Esc / 失焦）。 */
function onCreateCancel(): void {
  creating.value = null
}

/** 删除章节（→ 回收站，可恢复）。 */
async function doDelete(node: TreeNode): Promise<void> {
  if (!node.docId) return
  if (!confirm(`确认删除「${node.name}」？可从回收站恢复。`)) return
  try {
    await trashDocument(props.bookName!, node.docId)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** inline 重命名提交：校验名 → path → docId → PATCH rename（补 .md）→ 刷新。 */
async function onRenameCommit(path: string, value: string): Promise<void> {
  const name = sanitizeName(value)
  if (!name) {
    error.value = '名称不能为空，或含 / \\ 或以 . 开头'
    return // 保留 renamePath，让用户改
  }
  renamePath.value = null
  const docId = findDocIdByPath(nodes.value, path)
  if (!docId) return
  try {
    await renameDocument(props.bookName!, docId, `${name}.md`)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** inline 重命名取消（Esc / 失焦）。 */
function onRenameCancel(): void {
  renamePath.value = null
}

/** 加载回收站列表（容错，失败清空）。 */
async function loadTrash(): Promise<void> {
  if (!props.bookName) {
    trashEntries.value = []
    return
  }
  try {
    trashEntries.value = await listTrashEntries(props.bookName)
  } catch {
    trashEntries.value = []
  }
}

/** 恢复：POST /trash/:id/restore → 刷新树（恢复文件回位）+ 回收站。 */
async function doRestore(id: string): Promise<void> {
  try {
    await restoreTrashEntry(props.bookName!, id)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** 永久删除（二次确认，不可逆）：DELETE /trash/:id → 刷新回收站。 */
async function doPurge(id: string): Promise<void> {
  if (!confirm('永久删除不可恢复，确认？')) return
  try {
    await purgeTrashEntry(props.bookName!, id)
    await loadTrash()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** 回收站条目展示名：取路径末段去 .md。 */
function trashBasename(path: string): string {
  const seg = path.split('/').pop() ?? path
  return seg.replace(/\.md$/, '')
}

/** 当前拖拽源 path（null = 未拖）。 */
const draggedPath = ref<string | null>(null)

function onDragStart(path: string): void {
  draggedPath.value = path
}

function onDragEnd(): void {
  draggedPath.value = null
}

/** 跨卷移动：PATCH move（章号不变，只改卷归属）→ 刷新树。onDrop 与菜单「移动到」共用。 */
async function doMoveDocument(docId: string, toDir: string): Promise<void> {
  try {
    await moveDocument(props.bookName!, docId, toDir)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** drop 提交：sourcePath → docId → PATCH move（token 由 main.ts wrapper 自动注入）。 */
async function onDrop(sourcePath: string, targetPath: string): Promise<void> {
  draggedPath.value = null
  const docId = findDocIdByPath(nodes.value, sourcePath)
  if (!docId) return
  await doMoveDocument(docId, targetPath)
}

/** 递归找 path → docId（drop 提交用）。 */
function findDocIdByPath(ns: TreeNode[], path: string): string | undefined {
  for (const n of ns) {
    if (n.path === path) return n.docId
    if (n.children.length) {
      const f = findDocIdByPath(n.children, path)
      if (f) return f
    }
  }
  return undefined
}

/** 递归计叶子数（head-count 展示总文件数）。 */
function countLeaves(ns: TreeNode[]): number {
  let c = 0
  for (const n of ns) c += n.isDirectory ? countLeaves(n.children) : 1
  return c
}
const fileCount = computed(() => countLeaves(nodes.value))

async function load(): Promise<void> {
  if (!props.bookName) return
  loading.value = true
  error.value = ''
  try {
    const r = await fetch(`/api/books/${enc.value}/tree`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = (await r.json()) as { nodes: TreeNode[] }
    nodes.value = groupTree(d.nodes ?? [])
    const saved = loadExpanded()
    if (saved) {
      expanded.value = saved
    } else {
      expanded.value = defaultExpanded()
      saveExpanded(expanded.value)
    }
    await loadTrash()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(() => props.bookName, () => load(), { immediate: true })
</script>

<template>
  <div class="tree">
    <div class="tree-head">
      <span class="tree-head-label">目录</span>
      <span class="head-count">{{ fileCount }}</span>
    </div>
    <div v-if="copiedMsg" class="ft-toast">{{ copiedMsg }}</div>
    <div v-if="loading" class="ft-hint">加载中…</div>
    <div v-else-if="error" class="ft-hint" style="color: var(--cinnabar)">{{ error }}</div>
    <div v-else-if="!nodes.length" class="ft-hint">（无可编辑文件）</div>
    <div v-else class="tree-body" @contextmenu="onBlankContextMenu">
      <FileTreeNode
        v-for="n in nodes"
        :key="n.path"
        :node="n"
        :depth="0"
        :expanded="expanded"
        :current="current"
        :dragged-path="draggedPath"
        @toggle="toggle"
        @select="select"
        @dragstart="onDragStart"
        @dragend="onDragEnd"
        @drop="onDrop"
        @contextmenu="onContextMenu"
        :rename-path="renamePath"
        @rename-commit="onRenameCommit"
        @rename-cancel="onRenameCancel"
        :creating-dir-path="creating?.renderDir ?? null"
        :creating-kind="creating?.kind ?? null"
        :creating-seed="creating?.seed ?? ''"
        @create-commit="onCreateCommit"
        @create-cancel="onCreateCancel"
      />
    </div>
    <!-- 回收站（块1）：左栏底部可展开组，恢复/永删 -->
    <div v-if="trashEntries.length" class="ft-trash">
      <div class="ft-trash-head" @click="trashExpanded = !trashExpanded">
        <span class="ft-trash-caret">{{ trashExpanded ? '▾' : '▸' }}</span>
        <span class="ft-trash-label">回收站</span>
        <span class="ft-trash-count">{{ trashEntries.length }}</span>
      </div>
      <div v-if="trashExpanded" class="ft-trash-list">
        <div v-for="t in trashEntries" :key="t.id" class="ft-trash-item">
          <span class="ft-trash-name" :title="t.originalPath">{{ trashBasename(t.originalPath) }}</span>
          <span class="ft-trash-act" @click="doRestore(t.id)">恢复</span>
          <span class="ft-trash-act danger" @click="doPurge(t.id)">永删</span>
        </div>
      </div>
    </div>
    <TreeContextMenu
      :visible="menuVisible"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @select="onMenuSelect"
      @close="menuVisible = false"
    />
  </div>
</template>

<style scoped>
/* 左栏走全局 .tree/.tree-head/.head-count（v5-components.css）；此处仅补加载/错误/空态提示。 */
/* 目录往上贴近书名栏（收 .tree / .tree-head 顶部 padding，不动全局 BookAnchor） */
.tree {
  position: relative;
  padding-top: 0;
}
/* 「复制路径」闪现提示（toast，顶部居中，不可点） */
.ft-toast {
  position: absolute;
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 12px;
  background: var(--ink-cyan);
  color: #fff;
  font-size: 12px;
  border-radius: 6px;
  z-index: 20;
  pointer-events: none;
  white-space: nowrap;
}
.tree-head {
  padding-top: 1px;
}
.ft-hint {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-3);
}
.tree-body {
  padding: 2px 0;
}
/* 回收站组（块1）：左栏底部，恢复/永删 */
.ft-trash {
  margin-top: 8px;
  padding: 0 4px 8px;
}
.ft-trash-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  cursor: pointer;
  border-radius: 5px;
}
.ft-trash-head:hover {
  background: var(--flat-hover);
  color: var(--text-2);
}
.ft-trash-caret {
  width: 10px;
  font-size: 9px;
  flex-shrink: 0;
}
.ft-trash-label {
  flex: 1;
}
.ft-trash-count {
  font-size: 10px;
  font-weight: 400;
}
.ft-trash-list {
  padding: 2px 0;
}
.ft-trash-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 24px;
  margin: 1px 4px;
  border-radius: 5px;
}
.ft-trash-item:hover {
  background: var(--flat-hover);
}
.ft-trash-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ft-trash-act {
  font-size: 11px;
  color: var(--ink-cyan);
  cursor: pointer;
  flex-shrink: 0;
}
.ft-trash-act.danger {
  color: var(--cinnabar);
}
</style>
