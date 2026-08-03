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
} from '../../api/documents'
import { parseChapterFileName, isBodyKind } from '../../shared/words'
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

// --- inline 新建/重命名 ---
type Creating = {
  kind: 'chapter' | 'chapter-outline' | 'volume-outline' | 'character' | 'item' | 'foreshadow' | 'volume' | 'doc'
  renderDir: string
  fsDir: string
  seed: string
} | null
const creating = ref<Creating>(null)
const renamePath = ref<string | null>(null)
// 块2.2 篇章信息弹窗：编辑 标题 + 章号|篇号（落 fm + 路径同步 rename；长篇改文件名 / 短篇改篇目录名）
// isPiece 标记短篇正文（用「篇号」标签，3 位补零）
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
  const prefix = '定稿/正文/'
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
      if (!n.isDirectory && n.path.startsWith('定稿/正文/')) {
        const no = extractChapterNo(n.name)
        if (no && no > max) max = no
      }
      if (n.children.length) walk(n.children)
    }
  }
  walk(tree.grouped)
  return max + 1
}
function lastVolumePath(): string | null {
  const writeGroup = tree.grouped.find((n) => n.path === '写作')
  const vols = (writeGroup?.children ?? []).filter((n) => n.isDirectory && isVolumeDir(n.path))
  return vols.length ? (vols[vols.length - 1]?.path ?? null) : null
}
/** 正文现有卷数（用于卷纲编号推断：N = 卷数 + 1）。 */
function volumeCount(): number {
  const writeGroup = tree.grouped.find((n) => n.path === '写作')
  return (writeGroup?.children ?? []).filter((n) => n.isDirectory && isVolumeDir(n.path)).length
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
  const targets: { label: string; dir: string }[] = [{ label: '正文根', dir: '定稿/正文' }]
  const writeGroup = tree.grouped.find((n) => n.path === '写作')
  for (const v of (writeGroup?.children ?? []).filter((n) => n.isDirectory && isVolumeDir(n.path))) {
    targets.push({ label: v.name, dir: v.path })
  }
  return targets.filter((t) => t.dir !== parent)
}

// --- 菜单生成（五类，移植旧 FileTree.buildMenuItems）---
function buildMenuItems(node: TreeNode): MenuItem[] {
  const p = node.path
  if (node.isDirectory && isVolumeDir(p)) {
    return [{ key: 'new', label: '新建', submenu: [{ key: 'new-chapter', label: '章节' }] }]
  }
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
  if (node.isDirectory && p === '大纲/章纲') {
    return [{ key: 'new', label: '新建', submenu: [{ key: 'new-chapter-outline', label: '章纲' }] }]
  }
  if (node.isDirectory && p === '定稿/设定/角色') {
    return [{ key: 'new', label: '新建', submenu: [{ key: 'new-character', label: '角色' }] }]
  }
  if (node.isDirectory && p === '定稿/设定/物品') {
    return [{ key: 'new', label: '新建', submenu: [{ key: 'new-item', label: '物品' }] }]
  }
  if (node.isDirectory && p === '定稿/设定/伏笔') {
    return [{ key: 'new', label: '新建', submenu: [{ key: 'new-foreshadow', label: '伏笔' }] }]
  }
  if (node.isDirectory && (p.startsWith('大纲/') || p.startsWith('定稿/设定/'))) {
    return [{ key: 'new', label: '新建', submenu: [{ key: 'new-doc', label: '文档' }] }]
  }
  if (!node.isDirectory) return buildLeafMenu(node)
  return []
}
function buildLeafMenu(node: TreeNode): MenuItem[] {
  const items: MenuItem[] = [{ key: 'rename', label: '重命名' }]
  if (node.path.startsWith('定稿/正文/')) {
    items.push({ key: 'meta', label: '章节信息…' })
    const targets = moveToTargets(node)
    if (targets.length) {
      items.push({
        key: 'move',
        label: '移动到…',
        submenu: targets.map((t) => ({ key: `move:${t.dir}`, label: t.label })),
      })
    }
    items.push({ key: 'copy', label: '创建副本' })
  } else if (isBodyKind(node.path) && node.path.startsWith('篇/')) {
    // 短篇正文：标题/篇号编辑（联动文件名）；无跨卷移动（短篇集扁平）
    items.push({ key: 'meta', label: '篇章信息…' })
  }
  items.push({ key: 'sep-a', label: '', separator: true })
  items.push({ key: 'copy-path', label: '复制路径' })
  items.push({ key: 'sep-b', label: '', separator: true })
  items.push({ key: 'delete', label: '删除', danger: true })
  return items
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
  popup(
    [
      {
        key: 'new',
        label: '新建',
        submenu: [
          { key: 'new-volume', label: '卷' },
          { key: 'new-chapter-root', label: '章节' },
        ],
      },
    ],
    e.clientX,
    e.clientY,
    onMenuSelect,
  )
}

// --- 菜单动作分发 ---
function onMenuSelect(key: string): void {
  if (key === 'new-volume') return startCreate('volume', '写作', '定稿/正文')
  if (key === 'new-chapter-root') {
    const vol = lastVolumePath()
    return startCreate('chapter', vol ?? '写作', vol ?? '定稿/正文')
  }
  if (key.startsWith('move:')) {
    const node = menuNode.value
    if (node?.docId) void doMove(node.docId, key.slice('move:'.length))
    return
  }
  const node = menuNode.value
  if (!node) return
  if (key === 'new-chapter') startCreate('chapter', node.path, node.path)
  else if (key === 'new-chapter-outline') startCreate('chapter-outline', node.path, node.path)
  else if (key === 'new-character') startCreate('character', node.path, node.path)
  else if (key === 'new-item') startCreate('item', node.path, node.path)
  else if (key === 'new-foreshadow') startCreate('foreshadow', node.path, node.path)
  else if (key === 'new-doc') startCreate('doc', node.path, node.path)
  else if (key === 'rename') renamePath.value = node.path
  else if (key === 'meta') {
    const isPiece = isBodyKind(node.path) && node.path.startsWith('篇/')
    // 短篇/长篇均从文件名提取编号+标题（短篇 篇/N-标题.md，长篇 定稿/正文/N-标题.md）
    const m = parseChapterFileName(node.path)
    metaEditing.value = {
      docId: node.docId ?? '',
      标题: m?.标题 ?? node.name,
      num: m?.章号 ?? null,
      isPiece,
    }
  } else if (key === 'copy') void doCopy(node)
  else if (key === 'copy-path') void onCopyPath(node)
  else if (key === 'delete') void doDelete(node)
}

async function onCopyPath(node: TreeNode): Promise<void> {
  try {
    await navigator.clipboard.writeText(node.path)
  } catch {
    /* 浏览器限制静默 */
  }
}

// --- 篇章信息（块2.2）---
// 长篇传 { 标题, 章号 }；短篇传 { 标题, 篇号 }（后端按文档角色区分落 fm 字段 + 路径 rename）
async function onSaveMeta(meta: { 标题: string; num: number }): Promise<void> {
  const e = metaEditing.value
  if (!e) return
  metaEditing.value = null
  try {
    const payload = e.isPiece
      ? { 标题: meta.标题, 篇号: meta.num }
      : { 标题: meta.标题, 章号: meta.num }
    await updateChapterMetaDoc(props.bookName, e.docId, payload)
    await tree.load(props.bookName)
    // 路径可能变（长篇文件名 / 短篇篇目录名）→ 同步 doc entry.path
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
  startCreate('chapter', vol ?? '写作', vol ?? '定稿/正文')
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
      return startCreate('character', '定稿/设定', '定稿/设定/角色')
    case 'item':
      return startCreate('item', '定稿/设定', '定稿/设定/物品')
    case 'foreshadow':
      return startCreate('foreshadow', '定稿/设定', '定稿/设定/伏笔')
    case 'synopsis':
      return void createSingleton('大纲/总纲.md', '总纲')
    case 'worldview':
      return void createSingleton('定稿/设定/世界观.md', '世界观')
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
  try {
    const r = await createDoc(props.bookName, { relPath })
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
function onCreateCancel(): void {
  creating.value = null
}

// --- 重命名 ---
async function onRenameCommit(path: string, value: string): Promise<void> {
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
  const parsed = parseChapterFileName(node.path)
  const title = parsed?.标题 ?? node.name
  const no = String(nextChapterNo()).padStart(4, '0')
  const relPath = `定稿/正文/${no}-${title} 副本.md`
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

/** 收集所有目录路径（首次打开全展开用） */
function collectAllDirs(nodes: TreeNode[]): string[] {
  const dirs: string[] = []
  function walk(ns: TreeNode[]): void {
    for (const n of ns) {
      if (n.isDirectory) {
        dirs.push(n.path)
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return dirs
}

watch(
  () => props.bookName,
  async (name) => {
    if (!name) return
    await tree.load(name, true) // 切书：重扫盘（上次会话期间盘上可能被外部改过）
    // 首次打开（无持久化展开状态）→ 全展开
    if (ws.treeExpanded.length <= 1) {
      ws.treeExpanded = collectAllDirs(tree.grouped)
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
    <div v-if="tree.grouped.length" class="tree-legend">
      <span class="lg"><i class="lg-dot c-green"></i>定稿</span>
      <span class="lg"><i class="lg-dot c-yellow"></i>草稿</span>
      <span class="lg"><i class="lg-dot c-red"></i>待修</span>
      <span class="lg"><i class="lg-dot c-gray"></i>其他</span>
    </div>
    <div v-if="openError" class="hint err">{{ openError }}</div>
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
  padding: var(--size-4-1) 0;
  min-height: 100%;
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
}
/* 色点图例 */
.tree-legend {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px var(--size-4-3);
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 3px;
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
