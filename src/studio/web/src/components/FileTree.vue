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
      />
    </div>
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
</style>
