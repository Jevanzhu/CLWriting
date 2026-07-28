/**
 * 书架共享逻辑：分组 + 最新书 + 视图模式 + 建书表单 + 格式化纯函数。
 * Shelf.vue（全屏页）与 ShelfModal.vue（浮层）共用，差异仅在选书后的跳转。
 */
import { ref, computed } from 'vue'
import { useShelfStore } from '../stores/shelf'
import { apiJson } from '../api/client'

/** 字数千分位 + 万字简写（书卡紧凑展示）*/
export function formatWords(n?: number): string {
  if (!n) return '0 字'
  if (n < 10000) return `${n.toLocaleString()} 字`
  return `${(n / 10000).toFixed(1)} 万字`
}

/** 最近编辑相对时间（书卡「N 天前」）*/
export function formatRelative(iso?: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const min = Math.floor((Date.now() - then) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  return `${Math.floor(month / 12)} 年前`
}

/** 目标字数完成百分比（hero 卡进度条）*/
export function progressPercent(b: { words?: number; targetWords?: number }): number {
  if (!b.targetWords || !b.words) return 0
  return Math.min(100, Math.round((b.words / b.targetWords) * 100))
}

/** Linear 风光晕：鼠标位置写入 --mx/--my 驱动卡片 ::before 的 radial-gradient 圆心 */
export function onCardMove(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  el.style.setProperty('--mx', `${e.clientX - r.left}px`)
  el.style.setProperty('--my', `${e.clientY - r.top}px`)
}

/**
 * 书架共享状态：分组 + 视图模式 + 建书表单。
 * onCreated 回调在建书成功后调用，由外壳处理跳转（路由 / IPC / 关浮层）。
 */
export function useShelf(options?: {
  onCreated?: (name: string) => void
}) {
  const shelf = useShelfStore()

  // 按 kind 分组（长篇/短篇），空组不渲染
  const groups = computed(() => {
    const longBks = shelf.books.filter((b) => b.kind !== 'short')
    const shortBks = shelf.books.filter((b) => b.kind === 'short')
    return [
      { title: '长篇', books: longBks },
      { title: '短篇', books: shortBks },
    ].filter((g) => g.books.length)
  })

  // 最近编辑的书（hero「继续写作」用）
  const latestBook = computed(() => {
    const sorted = shelf.books
      .filter((b) => b.lastEdited)
      .sort((a, b) => new Date(b.lastEdited!).getTime() - new Date(a.lastEdited!).getTime())
    return sorted[0] ?? null
  })

  // 视图模式（网格/列表），localStorage 持久化用户偏好
  const storedView = typeof localStorage !== 'undefined' ? localStorage.getItem('clw-shelf-view') : null
  const viewMode = ref<'grid' | 'list'>(storedView === 'list' ? 'list' : 'grid')
  function setView(mode: 'grid' | 'list'): void {
    viewMode.value = mode
    try {
      localStorage.setItem('clw-shelf-view', mode)
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }

  // 新建书表单
  const showCreate = ref(false)
  const newName = ref('')
  const creating = ref(false)
  const createError = ref<string | null>(null)
  async function createBook(): Promise<void> {
    const name = newName.value.trim()
    if (!name) return
    creating.value = true
    createError.value = null
    try {
      await apiJson('/api/books', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      showCreate.value = false
      newName.value = ''
      await shelf.load()
      options?.onCreated?.(name)
    } catch (e) {
      createError.value = e instanceof Error ? e.message : String(e)
    } finally {
      creating.value = false
    }
  }

  return {
    shelf,
    groups,
    latestBook,
    viewMode,
    setView,
    showCreate,
    newName,
    creating,
    createError,
    createBook,
  }
}
