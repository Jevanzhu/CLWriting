<script setup lang="ts">
// 命令面板（⌘P）：分组模糊搜索 + 键盘选择（mockup .cmd-mask/.cmd-input-wrap/.cmd-list/.cmd-item/.cmd-group-label）。
// B 策略保留键盘逻辑；NModal/NInput → 原生 .cmd-mask 结构。
// 命令分组：书籍/导航/操作/文件/视图；操作组含动作命令（保存/新建书/专注/折叠/面板/设置/主题/字体）。
import { ref, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { listFiles, listBooks } from '../api/books'
import { useEditorState } from '../composables/useEditorState'
import { useUiState, type ShellMode } from '../composables/useUiState'
import { useTheme } from '../composables/useTheme'
import { useFont } from '../composables/useFont'
import { useHint } from '../composables/useHint'
import type { FileEntry, BookMeta } from '../types'

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

// 动作命令共享态
const { triggerSave } = useEditorState()
const { toggleFocus, toggleFoldL, togglePanel, openSettings } = useUiState()
const { theme, themes, setTheme, themeName } = useTheme()
const { appFontId, setAppFont, appFonts } = useFont()
const { hint } = useHint()

/** 当前态（从路由推断，专注命令需判断是否编辑态） */
const mode = computed<ShellMode>(() => {
  const p = route.path
  if (p.endsWith('/edit')) return 'edit'
  if (p.endsWith('/workbench')) return 'workbench'
  return 'overview'
})

/** 主题循环下一档 */
function nextTheme(): void {
  const i = themes.findIndex((t) => t.id === theme.value)
  const next = themes[(i + 1) % themes.length] ?? themes[0]!
  setTheme(next.id)
}
/** 界面字体循环下一档 */
function nextAppFont(): void {
  const i = appFonts.findIndex((f) => f.id === appFontId.value)
  const next = appFonts[(i + 1) % appFonts.length] ?? appFonts[0]!
  setAppFont(next.id)
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

/** 书籍组：快速跳转到其他书（对齐 mockup cmdGroups「书籍」分组） */
const books = ref<BookMeta[]>([])
async function loadBooks(): Promise<void> {
  try {
    books.value = (await listBooks()).books ?? []
  } catch {
    books.value = []
  }
}
watch(name, () => void loadBooks(), { immediate: true })
const bookItems = computed<Cmd[]>(() =>
  books.value
    .filter((b) => b.name !== name.value)
    .slice(0, 12)
    .map((b) => ({
      id: 'book-' + b.name,
      label: `跳到《${b.name}》`,
      hint: '',
      run: () => router.push(`/books/${encodeURIComponent(b.name)}`),
    })),
)

const groups = computed<CmdGroup[]>(() => {
  const go = (p: string) => () => router.push(p)

  // 全局操作（入口态/进书态都可用）
  const globalActions: Cmd[] = [
    { id: 'act-newbook', label: '新建书', hint: '⌘N', run: go('/books/new') },
    { id: 'act-libraries', label: '书库管理', hint: '', run: go('/libraries') },
    { id: 'act-shelf', label: '返回书架', hint: '', run: go('/shelf') },
    {
      id: 'act-openlibrary',
      label: '打开书库目录…',
      hint: '',
      run: () => {
        if (window.clwritingDesktop) void window.clwritingDesktop.openLibrary()
        else hint('书库目录选择为桌面端功能')
      },
    },
    { id: 'act-settings', label: '设置', hint: '⌘,', run: () => openSettings() },
    { id: 'act-theme', label: `切换主题（当前 ${themeName()}）`, hint: '', run: nextTheme },
    { id: 'act-font', label: '切换界面字体', hint: '', run: nextAppFont },
  ]

  // 入口态（无 enc）：仅全局操作
  if (!enc.value) {
    return [{ group: '操作', items: globalActions }]
  }

  const nav: CmdGroup = {
    group: '导航',
    items: [
      { id: 'go-overview', label: '总览：作品概要', hint: '⌘O', run: go(base.value) },
      { id: 'go-edit', label: '编辑：文件', hint: '⌘E', run: go(`${base.value}/edit`) },
      { id: 'go-workbench', label: '工作台', hint: '⌘W', run: go(`${base.value}/workbench`) },
    ],
  }
  // 编辑态动作（保存/专注/折叠/面板）
  const editActions: Cmd[] = [
    {
      id: 'act-save',
      label: '保存（编辑器）',
      hint: '⌘S',
      run: () => {
        triggerSave()
        hint('已触发保存')
      },
    },
    { id: 'act-focus', label: '专注模式', hint: '⌘⇧F', run: () => toggleFocus(mode.value) },
    { id: 'act-fold', label: '折叠侧栏', hint: '⌘B', run: () => toggleFoldL() },
    { id: 'act-panel', label: '详情面板', hint: '', run: () => togglePanel() },
  ]
  const action: CmdGroup = { group: '操作', items: [...editActions, ...globalActions] }

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

  const result: CmdGroup[] = []
  if (bookItems.value.length) result.push({ group: '书籍', items: bookItems.value })
  result.push(nav)
  result.push(action)
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
