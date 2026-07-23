<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import type { TreeNode } from '../../types/tree'
import {
  createDoc,
  renameDoc,
  moveDoc,
  deleteDoc,
} from '../../api/documents'
import ContextMenu, { type MenuItem } from '../ui/ContextMenu.vue'
import ChapterTreeItem from './ChapterTreeItem.vue'

// 章节树面板：GET /tree → groupTree 分组 → 递归渲染 + 六态角标 + 展开态持久化
//   + 右键菜单（五类）+ inline 新建/重命名 + 删除/移动 + 拖拽移动。
// CRUD 逻辑移植旧 FileTree（平价基准）。

const props = defineProps<{ bookName: string }>()
const tree = useTreeStore()
const doc = useDocStore()
const ws = useWorkspaceStore()

const expanded = ref<Set<string>>(new Set(['写作']))
const openError = ref<string | null>(null)

const activePath = computed<string | null>(
  () => (ws.activeDocId ? doc.get(ws.activeDocId)?.path ?? null : null),
)

// --- 菜单状态 ---
const menuVisible = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuItems = ref<MenuItem[]>([])
const menuNode = ref<TreeNode | null>(null)

// --- inline 新建/重命名 ---
type Creating = {
  kind: 'chapter' | 'volume' | 'doc'
  renderDir: string
  fsDir: string
  seed: string
} | null
const creating = ref<Creating>(null)
const renamePath = ref<string | null>(null)

// --- 拖拽 ---
const draggedPath = ref<string | null>(null)

const storageKey = computed(() => `clw2.filetree.${props.bookName}`)

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey.value)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    /* 损坏降级默认 */
  }
  return new Set(['写作'])
}
function saveExpanded(): void {
  try {
    localStorage.setItem(storageKey.value, JSON.stringify([...expanded.value]))
  } catch {
    /* ignore */
  }
}
function toggle(path: string): void {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expanded.value = next
  saveExpanded()
}

async function onSelect(node: TreeNode): Promise<void> {
  if (node.isDirectory || !node.docId) return
  openError.value = null
  try {
    await doc.open(node)
    ws.openTab(node.docId)
  } catch (e) {
    openError.value = e instanceof Error ? e.message : String(e)
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
  return vols.length ? vols[vols.length - 1].path : null
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
  if (node.isDirectory && (p.startsWith('大纲/') || p.startsWith('定稿/设定/'))) {
    return [{ key: 'new', label: '新建', submenu: [{ key: 'new-doc', label: '文档' }] }]
  }
  if (!node.isDirectory) return buildLeafMenu(node)
  return []
}
function buildLeafMenu(node: TreeNode): MenuItem[] {
  const items: MenuItem[] = [{ key: 'rename', label: '重命名' }]
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
  items.push({ key: 'sep-b', label: '', separator: true })
  items.push({ key: 'delete', label: '删除', danger: true })
  return items
}

function onContextMenu(node: TreeNode, x: number, y: number): void {
  const items = buildMenuItems(node)
  if (!items.length) return
  menuNode.value = node
  menuItems.value = items
  menuX.value = x
  menuY.value = y
  menuVisible.value = true
}
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
  else if (key === 'new-doc') startCreate('doc', node.path, node.path)
  else if (key === 'rename') renamePath.value = node.path
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

// --- 新建 ---
function startCreate(
  kind: 'chapter' | 'volume' | 'doc',
  renderDir: string,
  fsDir: string,
): void {
  const ancestors = collectAncestors(tree.grouped, renderDir)
  if (!ancestors && !tree.grouped.some((n) => n.path === renderDir)) {
    openError.value = '当前书库无该区域，无法在此新建'
    return
  }
  const seed = kind === 'chapter' ? `${nextChapterNo()}-未命名` : ''
  creating.value = { kind, renderDir, fsDir, seed }
  const next = new Set(expanded.value)
  next.add(renderDir)
  if (ancestors) for (const a of ancestors) next.add(a)
  expanded.value = next
  saveExpanded()
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
    openError.value = e instanceof Error ? e.message : String(e)
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
    openError.value = e instanceof Error ? e.message : String(e)
  }
}
function onRenameCancel(): void {
  renamePath.value = null
}

// --- 删除 ---
async function doDelete(node: TreeNode): Promise<void> {
  if (!node.docId) return
  if (!confirm(`确认删除「${node.name}」？可从回收站恢复。`)) return
  try {
    await deleteDoc(props.bookName, node.docId)
    await tree.load(props.bookName)
  } catch (e) {
    openError.value = e instanceof Error ? e.message : String(e)
  }
}

// --- 移动（菜单 + 拖拽共用）---
async function doMove(docId: string, toDir: string): Promise<void> {
  try {
    await moveDoc(props.bookName, docId, toDir)
    await tree.load(props.bookName)
  } catch (e) {
    openError.value = e instanceof Error ? e.message : String(e)
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

watch(
  () => props.bookName,
  async (name) => {
    if (!name) return
    await tree.load(name)
    expanded.value = loadExpanded()
  },
  { immediate: true },
)
</script>

<template>
  <div class="chapter-tree" @contextmenu="onBlankContextMenu($event)">
    <div class="side-title">章节树</div>
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
    <ContextMenu
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
.chapter-tree {
  padding: var(--size-4-2) 0;
  min-height: 100%;
}
.side-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0 var(--size-4-3) var(--size-4-2);
}
.hint {
  padding: 8px var(--size-4-3);
  font-size: 12px;
  color: var(--text-faint);
}
.hint.err {
  color: var(--text-error);
}
.tree-list {
  padding: 0 var(--size-4-1);
}
</style>
