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

/** 待 core：命中体检/伏笔问题的文件集合（路径），用于 dot 标红（对齐 mockup 问题章，如 ch5） */
const problemFiles = ref<Set<string>>(new Set())
/** 文件状态点（对齐 mockup .dot）：问题 red / 草稿 yellow / 定稿正文 green / 设定大纲 gray。
 *  cyan 为角色色（右栏人物），左栏文件用不到；red 待 core 填充 problemFiles 后生效。 */
function dotClass(path: string): string {
  if (problemFiles.value.has(path)) return 'red'
  if (/工作区[\\/]/.test(path)) return 'yellow'
  if (/定稿[\/\\]正文[\/\\]/.test(path)) return 'green'
  return 'gray'
}

watch(() => props.bookName, () => load(), { immediate: true })
</script>

<template>
  <div class="tree">
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
        <div v-if="fd.open" class="folder-body folder-body-scroll">
          <div
            v-for="f in filesIn(fd.prefix)"
            :key="f.path"
            class="file indent"
            :class="{ active: f.path === current }"
            @click="select(f.path)"
          >
            <span class="dot" :class="dotClass(f.path)"></span>{{ shortName(f.path) }}
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
/* 左栏走 mockup 全局样式（.tree/.tree-head/.folder/.file/.dot）；此处仅补 Vue 独有的加载/错误/空态提示。 */
.ft-hint{padding:8px 12px;font-size:12px;color:var(--text-3)}
/* 每个分栏内部独立滚动：固定 ≈10 章高度（290px / 每章 ~29px）后内部滚，
   避免 4 栏全展开时 sider 总长失控；偏离 mockup，治真实多文件场景 */
.folder-body-scroll{max-height:290px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--ink) 14%,transparent) transparent}
.folder-body-scroll::-webkit-scrollbar{width:5px}
.folder-body-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--ink) 12%,transparent);border-radius:3px}
</style>
