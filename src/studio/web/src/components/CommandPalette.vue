<script setup lang="ts">
// 命令面板（⌘P）：分组模糊搜索 + 键盘选择（mockup .cmd-mask/.cmd-input-wrap/.cmd-list/.cmd-item/.cmd-group-label）。
// B 策略保留键盘逻辑；NModal/NInput → 原生 .cmd-mask 结构；命令按 mockup 分组（导航/视图）。
import { ref, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { listFiles } from '../api/books'
import type { FileEntry } from '../types'

const show = defineModel<boolean>('show', { default: false })
const route = useRoute()
const router = useRouter()

const query = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const activeIdx = ref(0)

const enc = computed(() => (route.params.name ? encodeURIComponent(route.params.name as string) : ''))
const base = computed(() => `/books/${enc.value}`)

interface Cmd {
  id: string
  label: string
  hint: string
  run: () => void
}
interface CmdGroup {
  group: string
  items: Cmd[]
}

const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const files = ref<FileEntry[]>([])

async function loadFiles(): Promise<void> {
  if (!name.value) {
    files.value = []
    return
  }
  try {
    files.value = await listFiles(name.value)
  } catch {
    files.value = []
  }
}
watch(name, () => void loadFiles(), { immediate: true })

/** 文件组：正文 章/篇 快速跳转（对齐 mockup 文件操作组；从 listFiles 派生） */
const fileItems = computed<Cmd[]>(() =>
  files.value
    .filter((f) => /ch\d+\.md$/i.test(f.path) || /sp\d+\.md$/i.test(f.path))
    .slice(0, 15)
    .map((f) => {
      const m = f.path.match(/ch(\d+)|sp(\d+)/i)
      const no = m ? Number(m[1] ?? m[2]) : 0
      const unit = /sp/i.test(f.path) ? '篇' : '章'
      return {
        id: 'file-' + f.path,
        label: `跳到第 ${no} ${unit}`,
        hint: '',
        run: () => router.push(`${base.value}/edit?file=${encodeURIComponent(f.path)}`),
      }
    }),
)

const groups = computed<CmdGroup[]>(() => {
  if (!enc.value) return []
  const go = (p: string) => () => router.push(p)
  const nav: CmdGroup = {
    group: '导航',
    items: [
      { id: 'go-overview', label: '总览：作品概要', hint: '', run: go(base.value) },
      { id: 'go-edit', label: '编辑：文件', hint: '', run: go(`${base.value}/edit`) },
      { id: 'go-workbench', label: '工作台', hint: '', run: go(`${base.value}/workbench`) },
    ],
  }
  const view: CmdGroup = {
    group: '视图',
    items: [
      { id: 'go-health', label: '体检', hint: '', run: go(`${base.value}/health`) },
      { id: 'go-rhythm', label: '节奏', hint: '', run: go(`${base.value}/rhythm`) },
      { id: 'go-leads', label: '账本', hint: '', run: go(`${base.value}/leads`) },
      { id: 'go-settings', label: '设定', hint: '', run: go(`${base.value}/settings`) },
      { id: 'go-config', label: '配置', hint: '', run: go(`${base.value}/config`) },
    ],
  }
  const result: CmdGroup[] = [nav]
  if (fileItems.value.length) result.push({ group: '文件', items: fileItems.value })
  result.push(view)
  return result
})

/** 跨组过滤；flat 是当前可见命令的扁平序列（activeIdx 索引它） */
const filteredGroups = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return groups.value
  return groups.value
    .map((g) => ({ group: g.group, items: g.items.filter((c) => c.label.toLowerCase().includes(q)) }))
    .filter((g) => g.items.length > 0)
})
const flat = computed(() => filteredGroups.value.flatMap((g) => g.items))

watch(flat, () => {
  activeIdx.value = 0
})

function exec(c: Cmd): void {
  c.run()
  close()
}
function close(): void {
  show.value = false
  query.value = ''
}
watch(show, (s) => {
  if (s) {
    query.value = ''
    activeIdx.value = 0
    void nextTick(() => inputRef.value?.focus())
  }
})
function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIdx.value = Math.min(activeIdx.value + 1, flat.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIdx.value = Math.max(activeIdx.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const c = flat.value[activeIdx.value]
    if (c) exec(c)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}
</script>

<template>
  <div class="cmd-mask" :class="{ show }" @click.self="close">
    <div class="cmd-box">
      <div class="cmd-input-wrap">
        <span class="cmd-icon">⌘</span>
        <input
          ref="inputRef"
          v-model="query"
          placeholder="输入命令或搜索…（↑↓ 选择 · Enter 执行 · Esc 关闭）"
          autocomplete="off"
          @keydown="onKey"
        />
      </div>
      <div class="cmd-list">
        <template v-for="g in filteredGroups" :key="g.group">
          <div class="cmd-group-label">{{ g.group }}</div>
          <div
            v-for="c in g.items"
            :key="c.id"
            class="cmd-item"
            :class="{ sel: flat[activeIdx]?.id === c.id }"
            @click="exec(c)"
            @mouseenter="activeIdx = flat.findIndex((x) => x.id === c.id)"
          >
            <span class="cmd-name">{{ c.label }}</span>
            <span v-if="c.hint" class="cmd-shortcut">{{ c.hint }}</span>
          </div>
        </template>
        <div v-if="!flat.length" class="cmd-empty">无匹配命令</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* mockup 覆盖 .cmd-mask/.cmd-input-wrap/.cmd-list/.cmd-item/.cmd-group-label；.cmd-box 是内层卡片容器（components.css 未定义），此处补。 */
.cmd-box {
  width: 540px;
  max-width: 92vw;
  max-height: 60vh;
  background: var(--panel-80);
  backdrop-filter: blur(22px) saturate(1.4);
  -webkit-backdrop-filter: blur(22px) saturate(1.4);
  border: 1px solid var(--white-28);
  border-radius: 16px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow);
}
</style>
