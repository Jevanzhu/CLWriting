<script setup lang="ts">
// 编辑态左栏：文件树。GET /files 列可编辑文件，点选 → 跳 /edit?file=xxx 驱动中栏 Editor。
// Editor.vue watch route.query.file 同步 selected（见 Editor.vue 第二刀联动）。
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
  <div class="ft">
    <div v-if="loading" class="ft-hint">加载中…</div>
    <div v-else-if="error" class="ft-err">{{ error }}</div>
    <div v-else-if="!files.length" class="ft-hint">（无可编辑文件）</div>
    <div
      v-for="f in files"
      :key="f.path"
      class="ft-item"
      :class="{ active: f.path === current }"
      @click="select(f.path)"
    >
      <span class="ft-path">{{ f.path }}</span>
      <span class="ft-mode">{{ f.mode === 'text' ? '正文' : '设定' }}</span>
    </div>
  </div>
</template>

<style scoped>
.ft {
  padding: 4px 0;
}
.ft-hint,
.ft-err {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-3);
}
.ft-err {
  color: var(--cinnabar);
}
.ft-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  margin: 1px 4px;
  cursor: pointer;
  border-radius: 5px;
  font-size: 13px;
  color: var(--text-2);
}
.ft-item:hover {
  background: var(--hover);
  color: var(--ink);
}
.ft-item.active {
  color: var(--ink-cyan);
  background: var(--active-bg);
}
.ft-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.ft-mode {
  color: var(--text-3);
  font-size: 10px;
  flex-shrink: 0;
}
</style>
