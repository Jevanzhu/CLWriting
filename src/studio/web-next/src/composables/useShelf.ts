/**
 * 书架共享逻辑：分组 + 搜索/排序 + 最新书 + 视图模式 + 建书表单 + 格式化纯函数。
 * Shelf.vue（全屏页）与 ShelfModal.vue（浮层）共用，差异仅在选书后的跳转。
 */
import { ref, computed } from 'vue'
import { useShelfStore } from '../stores/shelf'
import { usePrefsStore } from '../stores/prefs'
import { useChatStore } from '../stores/chat'
import { apiJson, ApiError } from '../api/client'
import { deleteBook } from '../api/shelf'
import { friendlyError } from '../shared/error'
import { clearFalsePositiveMarks } from '../stores/check'
import { clearFailedDrafts, migrateFailedDrafts } from './useChatComposer'
import { treeFirstOpenKey, onboardPremiseKey } from '../shared/storage-keys'

/**
 * R46-6（四十六轮）：书名改名的渲染层按书键控状态迁移——删除路径有完整清理链
 * （deleteBooks 内联五件：R-5 误报灰显 / R26-83 失败草稿 / R37-28 章号记忆 /
 * R27-79 梗概+首开键），改名路径此前为零：旧名条目全部成孤儿（内存 Map 条目常驻
 * 至进程重启、localStorage 键永驻），且新名侧功能性丢失（章号语境记忆清零、发送
 * 失败草稿找回失效、机检误报灰显丢失、首开标记重套）。本函数 = 同族五件的
 * 「清理旧名 + 值搬家到新名」；localStorage 不可用（隐私模式）静默忽略——与删除
 * 链同口径。磁盘/登记/事件库的迁移由 renameBook API 负责，不在本层。
 */
export function migrateBookKeyedState(oldName: string, newName: string): void {
  if (oldName === newName) return
  useChatStore().migrateChapterMemo(oldName, newName)
  migrateFailedDrafts(oldName, newName)
  try {
    // 误报灰显键族 `clw-fp:<书>:<文档>`——前缀枚举逐键搬家（stores/check fpKey 同构）
    const oldPrefix = `clw-fp:${oldName}:`
    const newPrefix = `clw-fp:${newName}:`
    // length/key(i) 枚举（浏览器原生形态；Object.keys 对测试桩/隐私模式实现不稳）
    const n = localStorage.length
    for (let i = n - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k === null || !k.startsWith(oldPrefix)) continue
      const v = localStorage.getItem(k)
      if (v !== null) {
        localStorage.setItem(newPrefix + k.slice(oldPrefix.length), v)
        localStorage.removeItem(k)
      }
    }
    // 梗概 + 首开标记（shared/storage-keys 与写入方同源拼键）
    for (const keyOf of [onboardPremiseKey, treeFirstOpenKey]) {
      const v = localStorage.getItem(keyOf(oldName))
      if (v !== null) {
        localStorage.setItem(keyOf(newName), v)
        localStorage.removeItem(keyOf(oldName))
      }
    }
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

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
    if (creating.value) return // R70-25（十八轮）：Enter 不受按钮 disabled 管辖——双 Enter 第二笔撞重名误报失败
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
        // R71-26（七十一轮）：单书 404/NOT_FOUND 视为已删继续——部分失败后重试时弹窗
        // 仍带全量名单，已删成功的书再删必 404，照旧上抛会中断循环、剩余书永远删不掉；
        // 其余错误照旧中断记失败（保留弹窗可重试语义不变）
        try {
          await deleteBook(name)
        } catch (e) {
          if (!(e instanceof ApiError && (e.status === 404 || e.code === 'NOT_FOUND'))) throw e
        }
        // R-5（十五轮登记销账）：删书成功即清该书误报灰显键——同名重建书不继承旧灰显
        clearFalsePositiveMarks(name)
        // R26-83（二十六轮，登记顺手补清）：一并清该书对话失败草稿残留（module 级 Map
        // 原无书删除出口）——同名重建书不回填旧书幽灵文本
        clearFailedDrafts(name)
        // R37-28（三十七轮批E）：一并清该书章号显式记忆（chat store 按书记忆 Map 原无
        // 删除出口，删书残留）——同名重建书不回填旧书的章号语境，其它书记忆不受牵连
        useChatStore().clearChapterMemo(name)
        // R27-79（二十七轮）：连带清该书 localStorage 残留键——否则同名重建书继承已删书
        // 梗概（首启引导凭空带出旧稿设定）、且永不套章节树默认展开。两键均经
        // shared/storage-keys 与写入方同源拼键（R30-26（三十轮）：梗概键原硬编码冒号
        // 形态与 OnboardPremise 局部常量双源同串，同族断裂隐患一并收敛；首开键 R28-3）。
        // try 包裹对齐本文件 loadSortPreference：localStorage 不可用（隐私模式）时静默忽略
        try {
          localStorage.removeItem(onboardPremiseKey(name))
          // R28-3（二十八轮）：首开键原写死冒号形态 `clw2.tree-first-open:${name}`，而
          // 写入方 ChapterTreePanel 前缀为点号 'clw2.tree-first-open.'——冒号→点号键名
          // 断裂致 R26-74 首开标记删书永远清不掉、同名重建书永不套默认展开（R27-79
          // 落空一半）。改从 shared/storage-keys 与写入方同源拼键
          localStorage.removeItem(treeFirstOpenKey(name))
        } catch {
          /* localStorage 不可用时忽略 */
        }
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
