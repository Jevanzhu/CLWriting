import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useDocStore } from './doc'

/**
 * 工作区状态（细案 §5 + T1.3）：面板折叠态 + tabs 多开 + 持久化恢复。
 * tabs 持久化到 clw2.workspace.<书名>；恢复后由 Book.vue 调 validate 按 tree 剔除失效 docId。
 * 关闭 dirty tab 走 pendingCloseTabId → ConfirmDialog 三选（保存/放弃/取消）。
 */
export interface Tab {
  id: string
  docId: string
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const leftOpen = ref(true)
  const rightOpen = ref(true)
  const focusMode = ref(false)
  /** 左栏活动面板（细案 §5 leftPanel）。 */
  const leftPanel = ref<'tree' | 'search' | 'trash'>('tree')
  /** 主区活动视图：编辑器 / 工作台（ribbon 工作台钮切换；点章节回编辑器）。 */
  const activeView = ref<'editor' | 'workbench'>('editor')
  const tabs = ref<Tab[]>([])
  const activeTabId = ref<string | null>(null)
  const pendingCloseTabId = ref<string | null>(null)
  const bookName = ref<string | null>(null)

  /** 活动 tab 的 docId（EditorView / 树高亮消费）。 */
  const activeDocId = computed(
    () => tabs.value.find((t) => t.id === activeTabId.value)?.docId ?? null,
  )

  function storageKey(): string {
    return `clw2.workspace.${bookName.value}`
  }
  function persist(): void {
    if (!bookName.value) return
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify({ tabs: tabs.value, activeTabId: activeTabId.value }),
      )
    } catch {
      /* localStorage 不可用忽略 */
    }
  }

  /** 切书：载入持久化 tabs（不校验，校验由 Book.vue 调 validate）。 */
  function setBook(name: string): void {
    if (bookName.value === name) return
    bookName.value = name
    try {
      const raw = localStorage.getItem(storageKey())
      if (raw) {
        const data = JSON.parse(raw) as { tabs?: Tab[]; activeTabId?: string | null }
        tabs.value = data.tabs ?? []
        activeTabId.value = data.activeTabId ?? tabs.value[0]?.id ?? null
        return
      }
    } catch {
      /* 损坏降级空 */
    }
    tabs.value = []
    activeTabId.value = null
  }

  /** tree load 后校验：剔除失效 docId 的 tab（细案 §5 失效 tab 静默丢弃）。 */
  function validate(validDocIds: Set<string>): void {
    const before = tabs.value.length
    tabs.value = tabs.value.filter((t) => validDocIds.has(t.docId))
    if (activeTabId.value && !tabs.value.some((t) => t.id === activeTabId.value)) {
      activeTabId.value = tabs.value[0]?.id ?? null
    }
    if (tabs.value.length !== before) persist()
  }

  function openTab(docId: string): void {
    activeView.value = 'editor' // 点章节回编辑器视图
    const existing = tabs.value.find((t) => t.docId === docId)
    if (existing) {
      activeTabId.value = existing.id
      persist()
      return
    }
    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    tabs.value.push({ id, docId })
    activeTabId.value = id
    persist()
  }
  function activateTab(id: string): void {
    activeTabId.value = id
    persist()
  }
  function closeTab(id: string): void {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx < 0) return
    tabs.value.splice(idx, 1)
    if (activeTabId.value === id) {
      activeTabId.value = tabs.value[idx]?.id ?? tabs.value[idx - 1]?.id ?? null
    }
    persist()
  }

  /** 请求关闭：dirty 弹确认，否则直关。 */
  function requestClose(id: string): void {
    const tab = tabs.value.find((t) => t.id === id)
    if (!tab) return
    const doc = useDocStore()
    if (doc.get(tab.docId)?.dirty) pendingCloseTabId.value = id
    else closeTab(id)
  }
  /** 确认：保存后关闭。 */
  async function confirmSaveAndClose(): Promise<void> {
    const id = pendingCloseTabId.value
    pendingCloseTabId.value = null
    if (!id) return
    const tab = tabs.value.find((t) => t.id === id)
    if (!tab) return
    const doc = useDocStore()
    const ok = await doc.save(tab.docId, 'manual')
    if (ok) closeTab(id)
  }
  /** 确认：放弃更改关闭。 */
  function confirmDiscard(): void {
    const id = pendingCloseTabId.value
    pendingCloseTabId.value = null
    if (id) closeTab(id)
  }
  /** 取消关闭。 */
  function cancelClose(): void {
    pendingCloseTabId.value = null
  }

  function toggleLeft(): void {
    leftOpen.value = !leftOpen.value
  }
  function toggleRight(): void {
    rightOpen.value = !rightOpen.value
  }
  function toggleFocus(): void {
    focusMode.value = !focusMode.value
  }
  function setLeftPanel(p: 'tree' | 'search' | 'trash'): void {
    leftPanel.value = p
  }
  function setActiveView(v: 'editor' | 'workbench'): void {
    activeView.value = v
  }

  return {
    leftOpen,
    rightOpen,
    focusMode,
    leftPanel,
    activeView,
    tabs,
    activeTabId,
    activeDocId,
    pendingCloseTabId,
    bookName,
    setBook,
    validate,
    openTab,
    activateTab,
    closeTab,
    requestClose,
    confirmSaveAndClose,
    confirmDiscard,
    cancelClose,
    toggleLeft,
    toggleRight,
    toggleFocus,
    setLeftPanel,
    setActiveView,
  }
})
