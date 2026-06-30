<script setup lang="ts">
// 编辑态左栏：文件树。GET /files 列可编辑文件，点选 → 跳 /edit?file=xxx 驱动中栏 Editor。
// 对齐 mockup renderTree（.tree-head + .folder 折叠头 + .file.indent 子项）；
// 真实 listFiles 为扁平 path → template 按目录前缀分组占位 folder，无数据用「— 待 core」占位。
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
  <!-- mockup renderTree：.tree-head + .folder(折叠头) + .file.indent(子项)。
       Vue listFiles 是扁平 path 无 folder 元数据 → 按目录前缀(定稿/正文|大纲|定稿/设定|工作区)分组，
       folder 头静态占位(▾ 展开 + name)，折叠交互属 script 逻辑暂不做，子项常显保持层级感。 -->
  <div class="tree-head">
    <span class="tree-head-label">目录</span>
    <span class="head-count">{{ files.length }}</span>
  </div>
  <div v-if="loading" class="ft-hint">加载中…</div>
  <div v-else-if="error" class="ft-hint" style="color:var(--cinnabar)">{{ error }}</div>
  <div v-else-if="!files.length" class="ft-hint">（无可编辑文件）</div>
  <template v-else>
    <!-- 正文 folder（前缀 定稿/正文/） -->
    <div class="folder"><span class="caret">▾</span>正文</div>
    <div
      v-for="f in files.filter(x => x.path.startsWith('定稿/正文/'))"
      :key="f.path"
      class="file indent"
      :class="{ active: f.path === current }"
      @click="select(f.path)"
    >
      <span class="dot" :class="dotClass(f.path)"></span>
      <span class="ft-path">{{ f.path }}</span>
      <span class="ft-mode">{{ f.mode === 'text' ? '正文' : '设定' }}</span>
    </div>
    <div v-if="!files.some(x => x.path.startsWith('定稿/正文/'))" class="file indent ft-empty">
      <b style="color:var(--text-3)">—</b> <span class="ft-sub">待 core</span>
    </div>

    <!-- 大纲 folder（前缀 大纲/） -->
    <div class="folder"><span class="caret">▾</span>大纲</div>
    <div
      v-for="f in files.filter(x => x.path.startsWith('大纲/'))"
      :key="f.path"
      class="file indent"
      :class="{ active: f.path === current }"
      @click="select(f.path)"
    >
      <span class="dot" :class="dotClass(f.path)"></span>
      <span class="ft-path">{{ f.path }}</span>
      <span class="ft-mode">{{ f.mode === 'text' ? '正文' : '设定' }}</span>
    </div>
    <div v-if="!files.some(x => x.path.startsWith('大纲/'))" class="file indent ft-empty">
      <b style="color:var(--text-3)">—</b> <span class="ft-sub">待 core</span>
    </div>

    <!-- 设定 folder（前缀 定稿/设定/） -->
    <div class="folder"><span class="caret">▾</span>设定</div>
    <div
      v-for="f in files.filter(x => x.path.startsWith('定稿/设定/'))"
      :key="f.path"
      class="file indent"
      :class="{ active: f.path === current }"
      @click="select(f.path)"
    >
      <span class="dot" :class="dotClass(f.path)"></span>
      <span class="ft-path">{{ f.path }}</span>
      <span class="ft-mode">{{ f.mode === 'text' ? '正文' : '设定' }}</span>
    </div>
    <div v-if="!files.some(x => x.path.startsWith('定稿/设定/'))" class="file indent ft-empty">
      <b style="color:var(--text-3)">—</b> <span class="ft-sub">待 core</span>
    </div>

    <!-- 工作区 folder（前缀 工作区/） -->
    <div class="folder"><span class="caret">▾</span>工作区</div>
    <div
      v-for="f in files.filter(x => x.path.startsWith('工作区/'))"
      :key="f.path"
      class="file indent"
      :class="{ active: f.path === current }"
      @click="select(f.path)"
    >
      <span class="dot" :class="dotClass(f.path)"></span>
      <span class="ft-path">{{ f.path }}</span>
      <span class="ft-mode">{{ f.mode === 'text' ? '正文' : '设定' }}</span>
    </div>
    <div v-if="!files.some(x => x.path.startsWith('工作区/'))" class="file indent ft-empty">
      <b style="color:var(--text-3)">—</b> <span class="ft-sub">待 core</span>
    </div>
  </template>
</template>

<style scoped>
/* mockup 覆盖 .tree-head/.folder/.file(.indent)；此处补 Vue 独有：提示文本、行尾标签、空 folder 占位行。 */
.ft-hint{padding:8px 12px;font-size:12px;color:var(--text-3)}
.ft-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.ft-mode{color:var(--text-3);font-size:10px;flex-shrink:0;background:var(--hover);padding:1px 6px;border-radius:8px;margin-left:auto}
/* 空 folder 占位行：mockup folder 若无子项，画「— 待 core」占位保持视觉层级 */
.ft-empty{color:var(--text-3);font-size:12px;font-weight:400;cursor:default}
.ft-empty:hover{background:transparent}
.ft-sub{font-size:10px;opacity:.7}
</style>
