/**
 * 书架共享逻辑：分组 + 搜索/排序 + 最新书 + 视图模式 + 建书表单 + 格式化纯函数。
 * Shelf.vue（全屏页）与 ShelfModal.vue（浮层）共用，差异仅在选书后的跳转。
 */
import { ref, computed } from 'vue'
import { useShelfStore } from '../stores/shelf'
import { usePrefsStore } from '../stores/prefs'
import { apiJson } from '../api/client'
import { deleteBook } from '../api/shelf'
import { friendlyError } from '../shared/error'
import { clearFalsePositiveMarks } from '../stores/check'

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
 * onDeleted 回调在删除成功后调用（R65-54/E-6：ShelfModal 内删掉当前打开的书时，
 * 外壳借它导航离开死路由 /book/:name——留在原地则后续所有 API 全 404）。
 */
export function useShelf(options?: {
  onCreated?: (name: string) => void
  onDeleted?: (names: string[]) => void
}) {
  const shelf = useShelfStore()

  // ── 搜索 + 排序（P2-PROD-6）────────────────────
  /** 搜索词（按书名模糊匹配） */
  const query = ref('')
  type SortBy = 'recent' | 'created' | 'name'
  /** 排序方式：最近打开 / 创建时间 / 字母序（localStorage 持久化） */
  const sortBy = ref<SortBy>(loadSortPreference())
  const SORT_KEY = 'clw-shelf-sort'
  function loadSortPreference(): SortBy {
    try {
      const v = localStorage.getItem(SORT_KEY)
      return v === 'recent' || v === 'created' || v === 'name' ? v : 'recent'
    } catch {
      return 'recent'
    }
  }
  function setSortBy(v: SortBy): void {
    sortBy.value = v
    try {
      localStorage.setItem(SORT_KEY, v)
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }

  /** 按搜索词过滤 + 排序后的完整书列表 */
  const filteredBooks = computed(() => {
    const q = query.value.trim().toLowerCase()
    const books = q
      ? shelf.books.filter((b) => (b.title ?? b.name).toLowerCase().includes(q))
      : [...shelf.books]
    switch (sortBy.value) {
      case 'name':
        return books.sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name, 'zh-CN'))
      case 'created':
        return books.sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime())
      default: // recent
        return books.sort((a, b) => new Date(b.lastEdited ?? 0).getTime() - new Date(a.lastEdited ?? 0).getTime())
    }
  })

  // 按 kind 分组（长篇/短篇），空组不渲染
  const groups = computed(() => {
    const longBks = filteredBooks.value.filter((b) => b.kind !== 'short')
    const shortBks = filteredBooks.value.filter((b) => b.kind === 'short')
    return [
      { title: '长篇', books: longBks },
      { title: '短篇', books: shortBks },
    ].filter((g) => g.books.length)
  })

  // 最近编辑的书（hero「继续写作」用，不受搜索/排序影响——始终取全书最近）
  const latestBook = computed(() => {
    const sorted = shelf.books
      .filter((b) => b.lastEdited)
      .sort((a, b) => new Date(b.lastEdited!).getTime() - new Date(a.lastEdited!).getTime())
    return sorted[0] ?? null
  })

  // 视图模式（网格/列表），全局偏好持久化（global.json）
  const prefs = usePrefsStore()
  const viewMode = computed(() => prefs.shelfView)
  function setView(mode: 'grid' | 'list'): void {
    prefs.setShelfView(mode)
  }

  // 新建书表单
  const showCreate = ref(false)
  const newName = ref('')
  const newKind = ref<'long' | 'short'>('long')
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
        body: JSON.stringify({ name, kind: newKind.value }),
      })
      showCreate.value = false
      newName.value = ''
      newKind.value = 'long'
      await shelf.load()
      options?.onCreated?.(name)
    } catch (e) {
      createError.value = friendlyError(e)
    } finally {
      creating.value = false
    }
  }

  // ── 批量管理 + 删除 ──
  const batchMode = ref(false)
  const selected = ref<Set<string>>(new Set())
  /** 待删除的书名列表（非 null = 确认弹窗打开） */
  const confirmTarget = ref<string[] | null>(null)
  const deleting = ref(false)
  /** 删除失败时的错误信息（成功时为 null） */
  const deleteError = ref<string | null>(null)

  function toggleSelect(name: string): void {
    const s = new Set(selected.value)
    if (s.has(name)) s.delete(name)
    else s.add(name)
    selected.value = s
  }
  function selectAll(): void {
    selected.value = new Set(shelf.books.map((b) => b.name))
  }
  function enterBatch(): void {
    batchMode.value = true
    selected.value = new Set()
  }
  function exitBatch(): void {
    batchMode.value = false
    selected.value = new Set()
  }
  /** 打开确认弹窗（传入待删书名列表） */
  function requestDelete(names: string[]): void {
    if (names.length === 0) return
    deleteError.value = null
    confirmTarget.value = names
  }
  function cancelDelete(): void {
    confirmTarget.value = null
  }
  /** 确认删除：串行调 DELETE API → 刷新书架 → 退出批量模式 */
  async function confirmDelete(): Promise<void> {
    const names = confirmTarget.value
    if (!names || names.length === 0) return
    deleting.value = true
    try {
      for (const name of names) {
        await deleteBook(name)
        // R-5（十五轮登记销账）：删书成功即清该书误报灰显键——同名重建书不继承旧灰显
        clearFalsePositiveMarks(name)
      }
      confirmTarget.value = null
      // 删除完成后清选中 + 退出批量模式
      selected.value = new Set()
      batchMode.value = false
      await shelf.load()
      options?.onDeleted?.(names)
    } catch (e) {
      // 删除失败：保留弹窗 + 显示错误，用户可重试或取消
      deleteError.value = friendlyError(e)
      await shelf.load()
    } finally {
      deleting.value = false
    }
  }

  return {
    shelf,
    groups,
    latestBook,
    // 搜索 + 排序（P2-PROD-6）
    query,
    sortBy,
    setSortBy,
    viewMode,
    setView,
    showCreate,
    newName,
    newKind,
    creating,
    createError,
    createBook,
    // 批量管理 + 删除
    batchMode,
    selected,
    toggleSelect,
    selectAll,
    enterBatch,
    exitBatch,
    confirmTarget,
    deleting,
    deleteError,
    requestDelete,
    confirmDelete,
    cancelDelete,
  }
}
