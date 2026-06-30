<script setup lang="ts">
// 编辑态左栏：文件树。GET /files 列可编辑文件，点选 → 跳 /edit?file=xxx 驱动中栏 Editor。
// 对齐 mockup renderTree（.tree-head + .file）；真实 listFiles 为扁平列表（无 folder 折叠结构，不造假）。
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

watch(() => props.bookName, () => load(), { immediate: true })
</script>

<template>
  <div class="tree-head">
    <span class="tree-head-label">目录</span>
    <span class="head-count">{{ files.length }}</span>
  </div>
  <div v-if="loading" class="ft-hint">加载中…</div>
  <div v-else-if="error" class="ft-hint" style="color:var(--cinnabar)">{{ error }}</div>
  <div v-else-if="!files.length" class="ft-hint">（无可编辑文件）</div>
  <div
    v-for="f in files"
    :key="f.path"
    class="file"
    :class="{ active: f.path === current }"
    @click="select(f.path)"
  >
    <span class="ft-path">{{ f.path }}</span>
    <span class="ft-mode">{{ f.mode === 'text' ? '正文' : '设定' }}</span>
  </div>
</template>

<style scoped>
/* mockup 覆盖 .tree-head/.file；此处仅补提示文本与文件行尾部标签（mockup 无对应语义类）。 */
.ft-hint{padding:8px 12px;font-size:12px;color:var(--text-3)}
.ft-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.ft-mode{color:var(--text-3);font-size:10px;flex-shrink:0;background:var(--hover);padding:1px 6px;border-radius:8px;margin-left:auto}
</style>
