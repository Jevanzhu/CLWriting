<script setup lang="ts">
// 编辑态左栏：文件树。GET /files 列可编辑文件，点选 → 跳 /edit?file=xxx 驱动中栏 Editor。
// 对齐 mockup renderTree（.tree-head + .folder 折叠头 + .file.indent 子项）；
// 真实 listFiles 为扁平 path → 按目录前缀分 4 folder（可折叠），无数据用「— 待 core」占位。
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

interface FileEntry {
  path: string
  mode: 'text' | 'md'
}

const props = defineProps<{ bookName?: string }>()
const route = useRoute()
const router = useRouter()

const files = ref<FileEntry[]>([])
const loading = ref(false)
const error = ref('')

const enc = computed(() => (props.bookName ? encodeURIComponent(props.bookName) : ''))
// 当前选中 = 路由 query.file（与 Editor selected 同源）
const current = computed(() => (typeof route.query.file === 'string' ? route.query.file : ''))

/** 4 个目录分组（对齐 mockup renderTree 的 4 folder；可折叠） */
const folders = ref([
  { key: 'body', label: '正文', prefix: '定稿/正文/', open: true },
  { key: 'outline', label: '大纲', prefix: '大纲/', open: true },
  { key: 'settings', label: '设定', prefix: '定稿/设定/', open: true },
  { key: 'work', label: '工作区', prefix: '工作区/', open: true },
])

/** folder 子项（按前缀过滤） */
function filesIn(prefix: string): FileEntry[] {
  return files.value.filter((x) => x.path.startsWith(prefix))
}

/** 短名：路径 → basename 去 .md（对齐 mockup 短名展示，避免全路径冗长） */
function shortName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.md$/i, '')
}

async function load(): Promise<void> {
  if (!props.bookName) return
  loading.value = true
  error.value = ''
  try {
    const r = await fetch(`/api/books/${enc.value}/files`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = (await r.json()) as { files: FileEntry[] }
    files.value = d.files ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function select(path: string): void {
  router.push({ path: `/books/${enc.value}/edit`, query: { file: path } })
}

/** 文件状态点（对齐 mockup .dot）：正文已定稿 green / 工作区草稿 yellow / 设定大纲 gray */
function dotClass(path: string): string {
  if (/工作区[\\/]?草稿/i.test(path)) return 'yellow'
  if (/(chapters|pieces|篇)[\\/]/i.test(path)) return 'green'
  return 'gray'
}

watch(() => props.bookName, () => load(), { immediate: true })
</script>

<template>
  <div class="tree-head">
    <span class="tree-head-label">目录</span>
    <span class="head-count">{{ files.length }}</span>
  </div>
  <div v-if="loading" class="ft-hint">加载中…</div>
  <div v-else-if="error" class="ft-hint" style="color: var(--cinnabar)">{{ error }}</div>
  <div v-else-if="!files.length" class="ft-hint">（无可编辑文件）</div>
  <template v-else>
    <template v-for="fd in folders" :key="fd.key">
      <div class="folder" @click="fd.open = !fd.open">
        <span class="caret">{{ fd.open ? '▾' : '▸' }}</span>{{ fd.label }}
      </div>
      <template v-if="fd.open">
        <div
          v-for="f in filesIn(fd.prefix)"
          :key="f.path"
          class="file indent"
          :class="{ active: f.path === current }"
          @click="select(f.path)"
        >
          <span class="dot" :class="dotClass(f.path)"></span>
          <span class="ft-path">{{ shortName(f.path) }}</span>
          <span class="ft-mode">{{ f.mode === 'text' ? '正文' : '设定' }}</span>
        </div>
        <div v-if="!filesIn(fd.prefix).length" class="file indent ft-empty">
          <b style="color: var(--text-3)">—</b> <span class="ft-sub">待 core</span>
        </div>
      </template>
    </template>
  </template>
</template>

<style scoped>
/* mockup 覆盖 .tree-head/.folder/.file(.indent)；此处补 Vue 独有：提示文本、行尾标签、空 folder 占位行、折叠手型。 */
.folder{cursor:pointer;user-select:none}
.ft-hint{padding:8px 12px;font-size:12px;color:var(--text-3)}
.ft-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.ft-mode{color:var(--text-3);font-size:10px;flex-shrink:0;background:var(--hover);padding:1px 6px;border-radius:8px;margin-left:auto}
/* 空 folder 占位行：mockup folder 若无子项，画「— 待 core」占位保持视觉层级 */
.ft-empty{color:var(--text-3);font-size:12px;font-weight:400;cursor:default}
.ft-empty:hover{background:transparent}
.ft-sub{font-size:10px;opacity:.7}
</style>
