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

/** 按节点类型生成菜单项（Obsidian 式：新建折叠 ▸ 子菜单；卷改名/删后端不支持→后置）。 */
function buildMenuItems(node: TreeNode): MenuItem[] {
  const p = node.path
  // 卷目录：新建 ▸ 章节（卷本身不可改名/删，后端只管叶子）
  if (node.isDirectory && isVolumeDir(p)) {
    return [{ key: 'new', label: '新建', submenu: [{ key: 'new-chapter', label: '章节' }] }]
  }
  // 正文根 / 写作组：新建 ▸ [卷, 章节]
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
  // 章节叶子：重命名 / 删除
  if (!node.isDirectory && p.startsWith('定稿/正文/')) {
    return [
      { key: 'rename', label: '重命名' },
      { key: 'delete', label: '删除', danger: true },
    ]
  }
  // 大纲 / 设定目录：新建 ▸ 文档
  if (node.isDirectory && (p.startsWith('大纲/') || p.startsWith('定稿/设定/'))) {
    return [{ key: 'new', label: '新建', submenu: [{ key: 'new-doc', label: '文档' }] }]
  }
  return []
}

/** 菜单动作分发（子菜单子项 key 与普通项一致；rename → 节点内 inline）。 */
function onMenuSelect(key: string): void {
  const node = menuNode.value
  if (!node) return
  if (key === 'new-chapter') startCreate('chapter', node.path, node.path)
  else if (key === 'new-chapter-root') {
    // 有卷落末卷，无卷（扁平结构）渲染在「写作」组首位、落盘 定稿/正文/
    const vol = lastVolumePath()
    startCreate('chapter', vol ?? '写作', vol ?? '定稿/正文')
  } else if (key === 'new-volume') startCreate('volume', '写作', '定稿/正文')
  else if (key === 'new-doc') startCreate('doc', node.path, node.path)
  else if (key === 'rename') renamePath.value = node.path
  else if (key === 'delete') void doDelete(node)
}

/** 启动新建（Obsidian 式就地）：算渲染落点 + 落盘目录 + 预填值，并展开目标目录（子级首位出输入框）。 */
function startCreate(
  kind: 'chapter' | 'volume' | 'doc',
  renderDir: string,
  fsDir: string,
): void {
  const seed = kind === 'chapter' ? `${nextChapterNo()}-未命名` : ''
  creating.value = { kind, renderDir, fsDir, seed }
  if (!expanded.value.has(renderDir)) {
    const next = new Set(expanded.value)
    next.add(renderDir)
    expanded.value = next
    saveExpanded(next)
  }
}

/** 就地新建提交（FileTreeNode emit 输入值）：算 relPath → POST → 刷新 + 跳编辑器。 */
async function onCreateCommit(value: string): Promise<void> {
  const c = creating.value
  creating.value = null
  if (!c || !value) return
  const relPath =
    c.kind === 'volume'
      ? `${c.fsDir}/${value}/${nextChapterNo()}-未命名.md`
      : `${c.fsDir}/${value}.md`
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

/** inline 重命名提交：path → docId → PATCH rename（补 .md）→ 刷新。 */
async function onRenameCommit(path: string, value: string): Promise<void> {
  renamePath.value = null
  if (!value) return
  const docId = findDocIdByPath(nodes.value, path)
  if (!docId) return
  try {
    await renameDocument(props.bookName!, docId, `${value}.md`)
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

/** drop 提交：sourcePath → docId → PATCH move → refetch /tree（token 由 main.ts wrapper 自动注入）。 */
async function onDrop(sourcePath: string, targetPath: string): Promise<void> {
  draggedPath.value = null
  const docId = findDocIdByPath(nodes.value, sourcePath)
  if (!docId) return
  try {
    const r = await fetch(`/api/books/${enc.value}/documents/${encodeURIComponent(docId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'move', toDir: targetPath }),
    })
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { reason?: string; code?: string }
      error.value = `移动失败：${j.reason ?? j.code ?? r.status}`
    } else {
      await load()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
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
    <div v-if="loading" class="ft-hint">加载中…</div>
    <div v-else-if="error" class="ft-hint" style="color: var(--cinnabar)">{{ error }}</div>
    <div v-else-if="!nodes.length" class="ft-hint">（无可编辑文件）</div>
    <div v-else class="tree-body">
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
  padding-top: 0;
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
