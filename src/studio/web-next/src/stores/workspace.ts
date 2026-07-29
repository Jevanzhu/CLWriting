import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useDocStore } from './doc'

/** 新建类型：正文/章纲/卷纲/总纲/角色/物品/世界观（TabBar 下拉 → ChapterTreePanel 执行）。 */
export type CreateKind =
  | 'chapter'
  | 'chapter-outline'
  | 'volume-outline'
  | 'synopsis'
  | 'character'
  | 'item'
  | 'worldview'

/**
 * 工作区状态：面板折叠态 + 当前文档 + 持久化恢复。
 * activeDocId 持久化到 clw2.workspace.<书名>；恢复后由 Book.vue 调 validate 按 tree 剔除失效 docId。
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const leftOpen = ref(true)
  const rightOpen = ref(true)
  /** 左栏宽度（可拖拽调整，最小 180）。 */
  const leftWidth = ref(220)
  const focusMode = ref(false)
  /** 左栏活动面板（细案 §5 leftPanel）。 */
  const leftPanel = ref<'tree' | 'search' | 'trash'>('tree')
  /** 主区活动视图：编辑器 / 工作台 / 开书对话 / 总览（ribbon 切换；点章节回编辑器）。 */
  const activeView = ref<'editor' | 'workbench' | 'onboard' | 'overview' | 'rhythm' | 'relations' | 'learn'>('editor')
  /** 右栏活动 tab（信息/审阅/机检/分析）；编辑器 AI 按钮可驱动切到审阅。 */
  const rightTab = ref<'info' | 'review' | 'check'>('info')
  /** 当前打开的文档 ID（单文档模式，无标签页）。 */
  const activeDocId = ref<string | null>(null)
  /** 新建信号（TabBar 触发 → ChapterTreePanel 监听执行）。createKind 标记类型，createTick 递增触发。 */
  const createKind = ref<CreateKind>('chapter')
  const createTick = ref(0)
  /** 待插入正文文本（右栏速查 → 编辑器，命令管道）。null = 无待插入。 */
  const pendingInsert = ref<string | null>(null)
  /** 编辑器选区读取器（EditorView onMounted 注册；选段改写读当前选区）。null = 无编辑器。 */
  const editorGetSelection = ref<(() => string) | null>(null)
  const bookName = ref<string | null>(null)

  /** UI 偏好（全局，不按书区分）：左栏宽度 + 面板折叠态 + 左栏面板类型。
   *  初始化时从 localStorage 读，后续 watch 自动写回（刷新/重启后保持）。 */
  const UI_PREFS_KEY = 'clw2.ui-prefs'
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<{
        leftWidth: number
        leftOpen: boolean
        rightOpen: boolean
        leftPanel: 'tree' | 'search' | 'trash'
      }>
      if (typeof p.leftWidth === 'number' && p.leftWidth >= 180) leftWidth.value = p.leftWidth
      if (typeof p.leftOpen === 'boolean') leftOpen.value = p.leftOpen
      if (typeof p.rightOpen === 'boolean') rightOpen.value = p.rightOpen
      if (p.leftPanel === 'tree' || p.leftPanel === 'search' || p.leftPanel === 'trash') leftPanel.value = p.leftPanel
    }
  } catch {
    /* 损坏降级默认 */
  }
  watch([leftWidth, leftOpen, rightOpen, leftPanel], () => {
    try {
      localStorage.setItem(
        UI_PREFS_KEY,
        JSON.stringify({
          leftWidth: leftWidth.value,
          leftOpen: leftOpen.value,
          rightOpen: rightOpen.value,
          leftPanel: leftPanel.value,
        }),
      )
    } catch {
      /* localStorage 不可用忽略 */
    }
  })

  function storageKey(): string {
    return `clw2.workspace.${bookName.value}`
  }
  function persist(): void {
    if (!bookName.value) return
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify({ activeDocId: activeDocId.value }),
      )
    } catch {
      /* localStorage 不可用忽略 */
    }
  }

  /** 切书：载入持久化 activeDocId（不校验，校验由 Book.vue 调 validate）。 */
  function setBook(name: string): void {
    if (bookName.value === name) return
    bookName.value = name
    try {
      const raw = localStorage.getItem(storageKey())
      if (raw) {
        const data = JSON.parse(raw) as { activeDocId?: string | null }
        activeDocId.value = data.activeDocId ?? null
        return
      }
    } catch {
      /* 损坏降级空 */
    }
    activeDocId.value = null
  }

  /** tree load 后校验：activeDocId 失效则清空。 */
  function validate(validDocIds: Set<string>): void {
    if (activeDocId.value && !validDocIds.has(activeDocId.value)) {
      activeDocId.value = null
      persist()
    }
  }

  /** 打开文档（单文档模式）：切到编辑器视图 + 旧文档 dirty 自动保存。 */
  function openTab(docId: string): void {
    activeView.value = 'editor'
    if (activeDocId.value && activeDocId.value !== docId) {
      const doc = useDocStore()
      if (doc.get(activeDocId.value)?.dirty) void doc.save(activeDocId.value, 'autosave')
    }
    activeDocId.value = docId
    persist()
  }

  /** 触发新建（TabBar → ChapterTreePanel 监听 createTick 执行；kind 标记新建类型）。 */
  function triggerCreate(kind: CreateKind = 'chapter'): void {
    createKind.value = kind
    createTick.value++
  }
  /** 请求插入文本到编辑器光标（右栏速查「插入」用）。 */
  function requestInsert(text: string): void {
    pendingInsert.value = text
  }
  /** 消费待插入文本（EditorView 执行后清空信号）。 */
  function consumeInsert(): string | null {
    const t = pendingInsert.value
    pendingInsert.value = null
    return t
  }

  function toggleLeft(): void {
    leftOpen.value = !leftOpen.value
  }
  function setLeftWidth(w: number): void {
    leftWidth.value = Math.max(180, w)
  }
  function toggleRight(): void {
    rightOpen.value = !rightOpen.value
  }
  function toggleFocus(): void {
    focusMode.value = !focusMode.value
  }
  function setLeftPanel(p: 'tree' | 'search' | 'trash'): void {
    leftPanel.value = p
    leftOpen.value = true // 从 ribbon 点面板入口时确保左栏打开
  }
  /** 切右栏 tab（编辑器 AI 按钮调用时自动展开右栏）。 */
  function setRightTab(t: 'info' | 'review' | 'check'): void {
    rightTab.value = t
    rightOpen.value = true
  }
  function setActiveView(v: 'editor' | 'workbench' | 'onboard' | 'overview' | 'rhythm' | 'relations' | 'learn'): void {
    activeView.value = v
  }
  /** 注册/注销编辑器选区读取器（EditorView mount/unmount；选段改写用）。 */
  function setEditorGetSelection(fn: (() => string) | null): void {
    editorGetSelection.value = fn
  }

  return {
    leftOpen,
    leftWidth,
    rightOpen,
    focusMode,
    leftPanel,
    activeView,
    rightTab,
    activeDocId,
    createKind,
    createTick,
    bookName,
    setBook,
    validate,
    openTab,
    triggerCreate,
    toggleLeft,
    setLeftWidth,
    toggleRight,
    toggleFocus,
    setLeftPanel,
    setRightTab,
    setActiveView,
    pendingInsert,
    requestInsert,
    consumeInsert,
    editorGetSelection,
    setEditorGetSelection,
  }
})
