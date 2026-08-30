import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useDocStore } from './doc'
import { usePrefsStore } from './prefs'
import { getBookPrefs, putBookPrefs, type BookPrefs } from '../api/prefs'
import { setFullScreen } from '../shared/fullscreen'

/** 新建类型：正文/章纲/卷纲/总纲/角色/物品/世界观/伏笔（TabBar 下拉 → ChapterTreePanel 执行）。 */
export type CreateKind =
  | 'chapter'
  | 'chapter-outline'
  | 'volume-outline'
  | 'synopsis'
  | 'character'
  | 'item'
  | 'worldview'
  | 'foreshadow'

/**
 * 工作区状态：面板折叠态 + 当前文档 + 持久化恢复。
 *
 * 三级配置架构（A+B，对齐 Obsidian）：
 * - 全局偏好（主题/字体/字号/行距/段距）→ .clwriting/global.json（跨书共享）
 * - 书级偏好（面板布局/最后文档）→ .clwriting/prefs.json（跟随书）
 * - 章节级（标题/标签）→ frontmatter（不变）
 *
 * 切书时异步加载 .clwriting/prefs.json 恢复布局；变更时 debounce 写回。
 * 首次加载如 prefs.json 不存在，从旧 localStorage 自动迁移。
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
  const activeView = ref<'editor' | 'workbench' | 'onboard' | 'overview' | 'relations' | 'learn' | 'style' | 'audit'>('editor')
  /** 右栏活动 tab（信息/审阅/机检/分析）；编辑器 AI 按钮可驱动切到审阅。 */
  const rightTab = ref<'info' | 'review' | 'check'>('info')
  /** 当前打开的文档 ID（单文档模式，无标签页）。 */
  const activeDocId = ref<string | null>(null)
  /** 章节树展开路径（持久化到 prefs.json）。 */
  const treeExpanded = ref<string[]>(['写作'])
  /** 新建信号（TabBar 触发 → ChapterTreePanel 监听执行）。createKind 标记类型，createTick 递增触发。 */
  const createKind = ref<CreateKind>('chapter')
  const createTick = ref(0)
  /** 待插入正文文本（右栏速查 → 编辑器，命令管道）。null = 无待插入。
   *  第五轮：{text, tick} 结构——纯字符串时同值再点不触发 watcher（ref 同值赋值短路），
   *  「非编辑器视图下点插入 → 切回编辑器 → 再点同名」会永久丢失该信号；tick 递增保证
   *  每次点击都是新引用，EditorView 挂载后的 watch(immediate) 也能补消费。 */
  const pendingInsert = ref<{ text: string; tick: number } | null>(null)
  let insertTick = 0
  /** 编辑器选区读取器（EditorView onMounted 注册；选段改写读当前选区）。null = 无编辑器。 */
  const editorGetSelection = ref<(() => string) | null>(null)
  const bookName = ref<string | null>(null)

  // ── 书库级 prefs 加载/持久化 ──
  let prefsLoaded = false
  let watchStop: (() => void) | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** 切书 generation token：防止快速切换 A→B→C 时 A 的异步 prefs 覆盖 C（竞态污染） */
  let bookGen = 0

  /** 切书：异步加载书库级 prefs（工作区布局 + 最后打开文档）。 */
  function setBook(name: string): void {
    if (bookName.value === name) return
    bookName.value = name
    prefsLoaded = false
    activeDocId.value = null
    // R64-32（十二轮）：A 书展开态不带入 B 书——loadBookPrefs 失败路径（R-6 不置
    // prefsLoaded）下旧展开路径滞留作用于 B 书树（同名「写作」组直接命中）
    treeExpanded.value = ['写作']
    // FE-4（第七轮）：滞留插入信号随切书作废——非编辑器视图点「插入」后切书，
    // 新书编辑器 tryConsumeInsert 三口会把 A 书设定名插进 B 书正文
    pendingInsert.value = null
    if (debounceTimer) clearTimeout(debounceTimer) // ff 细节#11：挂起的落盘随切书作废
    debounceTimer = null
    const gen = ++bookGen
    void loadBookPrefs(gen)
  }

  /** 从 .clwriting/prefs.json 加载书库级偏好；首次为空时从旧 localStorage 迁移。 */
  async function loadBookPrefs(gen = bookGen): Promise<void> {
    if (!bookName.value) return
    let prefs: BookPrefs = {}
    try {
      prefs = await getBookPrefs(bookName.value)
    } catch {
      // R-6（第十六轮）：拉取失败直接放弃——不置 prefsLoaded、不 startPersistWatch（下次进书重试），
      // 否则默认布局经持久化 watch 写回覆盖服务端已存的 prefs.json
      return
    }

    // 竞态守卫：await 期间若已切到其他书 → 丢弃本次结果，防 A 的 prefs 写入 C 的 slot
    if (gen !== bookGen) return

    // 向后兼容：prefs.json 成功读到且为空时从旧 localStorage 迁移（R-6：拉取失败已提前 return，不会误迁移写回）
    if (Object.keys(prefs).length === 0) {
      let migrated = false
      try {
        const oldUi = localStorage.getItem('clw2.ui-prefs')
        if (oldUi) {
          const p = JSON.parse(oldUi)
          if (typeof p.leftWidth === 'number') prefs.leftWidth = p.leftWidth
          if (typeof p.leftOpen === 'boolean') prefs.leftOpen = p.leftOpen
          if (typeof p.rightOpen === 'boolean') prefs.rightOpen = p.rightOpen
          if (p.leftPanel) prefs.leftPanel = p.leftPanel
        }
        const oldWs = localStorage.getItem(`clw2.workspace.${bookName.value}`)
        if (oldWs) {
          const w = JSON.parse(oldWs)
          if (w.activeDocId !== undefined) prefs.activeDocId = w.activeDocId
        }
        const oldTree = localStorage.getItem(`clw2.filetree.${bookName.value}`)
        if (oldTree) {
          const arr = JSON.parse(oldTree)
          // R26-79（二十六轮）：迁移元素验 string——非 string 脏值（数字/null/嵌套）过滤掉，
          // 否则树展开渲染按 path 比对时出现无主条目
          if (Array.isArray(arr)) prefs.treeExpanded = arr.filter((x): x is string => typeof x === 'string')
        }
        migrated = Object.keys(prefs).length > 0
      } catch { /* 损坏降级 */ }
      if (migrated) {
        void putBookPrefs(bookName.value, prefs).catch(() => {})
        // R26-79：迁移后清旧键（对齐 prefs store 的 clearLegacyLocalStorage 手法）——
        // 不清则每次 prefs.json 为空的新书都会重复走迁移分支；清失败静默（下次重迁移无害）
        try {
          localStorage.removeItem('clw2.ui-prefs')
          localStorage.removeItem(`clw2.workspace.${bookName.value}`)
          localStorage.removeItem(`clw2.filetree.${bookName.value}`)
        } catch { /* localStorage 不可用降级 */ }
      }
    }

    // 应用 prefs 到 store
    if (typeof prefs.leftWidth === 'number' && prefs.leftWidth >= 180) leftWidth.value = prefs.leftWidth
    if (typeof prefs.leftOpen === 'boolean') leftOpen.value = prefs.leftOpen
    if (typeof prefs.rightOpen === 'boolean') rightOpen.value = prefs.rightOpen
    if (prefs.leftPanel === 'tree' || prefs.leftPanel === 'search' || prefs.leftPanel === 'trash') leftPanel.value = prefs.leftPanel
    // R72-11（二十轮 F-2）：prefs 迟到回填仅在当前未打开文档时生效——用户已点开另一
    // 文档后被覆盖回 prefs 记录（既有 gen 守卫只防跨书异步竞态，不防同书用户操作）
    if (activeDocId.value === null) activeDocId.value = prefs.activeDocId ?? null
    if (Array.isArray(prefs.treeExpanded)) treeExpanded.value = prefs.treeExpanded

    // 注入书级覆盖到 prefs store（pageWidth / autosaveInterval）
    const ps = usePrefsStore()
    ps.bookPageWidth = typeof prefs.pageWidth === 'number' ? prefs.pageWidth : null
    ps.bookAutosaveInterval = typeof prefs.autosaveInterval === 'number' ? prefs.autosaveInterval : null
    ps.apply()

    prefsLoaded = true
    startPersistWatch()
  }

  /** 启动 watch：面板布局/文档变更时 debounce 写回 .clwriting/prefs.json。 */
  function startPersistWatch(): void {
    if (watchStop) watchStop()
    const ps = usePrefsStore()
    watchStop = watch(
      [leftWidth, leftOpen, rightOpen, leftPanel, activeDocId, treeExpanded,
       () => ps.bookPageWidth, () => ps.bookAutosaveInterval],
      () => {
        if (!prefsLoaded || !bookName.value) return
        if (debounceTimer) clearTimeout(debounceTimer)
        // ff 细节#11：捕获排定时刻的书，fire 时复查（500ms 内切书 → 本次落盘作废，
        // 防 A 书布局经 setTimeout 回调写进 B 书 prefs.json）
        const gen = bookGen
        const name = bookName.value
        debounceTimer = setTimeout(() => {
          if (gen !== bookGen || !prefsLoaded || bookName.value !== name) return
          void putBookPrefs(name, {
            leftWidth: leftWidth.value,
            leftOpen: leftOpen.value,
            rightOpen: rightOpen.value,
            leftPanel: leftPanel.value,
            activeDocId: activeDocId.value,
            treeExpanded: treeExpanded.value,
            pageWidth: ps.bookPageWidth ?? undefined,
            autosaveInterval: ps.bookAutosaveInterval ?? undefined,
          }).catch(() => {})
        }, 500)
      },
    )
  }

  /** tree load 后校验：activeDocId 失效则清空（watch 自动持久化）。 */
  function validate(validDocIds: Set<string>): void {
    if (activeDocId.value && !validDocIds.has(activeDocId.value)) {
      activeDocId.value = null
    }
  }

  /** 打开文档（单文档模式）：切到编辑器视图 + 旧文档 dirty 自动保存（watch 自动持久化）。 */
  function openTab(docId: string): void {
    activeView.value = 'editor'
    if (activeDocId.value && activeDocId.value !== docId) {
      const doc = useDocStore()
      if (doc.get(activeDocId.value)?.dirty) void doc.save(activeDocId.value, 'autosave')
    }
    activeDocId.value = docId
  }

  /** 触发新建（TabBar → ChapterTreePanel 监听 createTick 执行；kind 标记新建类型）。 */
  function triggerCreate(kind: CreateKind = 'chapter'): void {
    createKind.value = kind
    createTick.value++
  }
  /** 请求插入文本到编辑器光标（右栏速查「插入」用）。 */
  function requestInsert(text: string): void {
    pendingInsert.value = { text, tick: ++insertTick }
  }
  /** 消费待插入文本（EditorView 执行后清空信号）。 */
  function consumeInsert(): { text: string; tick: number } | null {
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
  /** 进入/退出专注模式（全入口单源：热键/菜单/退出按钮/全屏反向同步都走这里）。
   *  真专注 = 隐藏 UI + 窗口全屏；全屏失败静默降级（隐藏态不受影响）。 */
  function setFocus(on: boolean): void {
    focusMode.value = on
    setFullScreen(on)
  }
  function toggleFocus(): void {
    setFocus(!focusMode.value)
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
  function setActiveView(v: 'editor' | 'workbench' | 'onboard' | 'overview' | 'relations' | 'learn' | 'style' | 'audit'): void {
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
    treeExpanded,
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
    setFocus,
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
