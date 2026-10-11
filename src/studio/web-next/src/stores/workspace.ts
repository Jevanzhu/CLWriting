import { defineStore } from 'pinia'
import { ref, computed, shallowRef, watch, nextTick, type ComputedRef, type Ref } from 'vue'
import { useDocStore } from './doc'
import { usePrefsStore } from './prefs'
import { useUiStore } from './ui'
import { getBookPrefs, putBookPrefs, type BookPrefs } from '../api/prefs'
import { createBookConfigCache, type BookConfigRead } from '../shared/book-config-cache'
import { setFullScreen } from '../shared/fullscreen'
import { flushBodyWriteback } from '../shared/body-writeback'
import { useStaleGuard } from '../composables/useStaleGuard'

/** 新建类型：正文/章纲/卷纲/总纲/角色/物品/世界观/伏笔（TabBar 下拉 → ChapterTreePanel 执行）。 */
export type CreateKind =
  'chapter' | 'chapter-outline' | 'volume-outline' | 'synopsis' | 'character' | 'item' | 'worldview' | 'foreshadow'

/** 左栏活动面板（联合类型单源——ref 初值与 setter 形参此前各写一遍
 *  字面量联合，改一处漏一处编译器不报，收成别名两处共引）。 */
export type LeftPanel = 'tree' | 'search' | 'trash'
/** 主区活动视图：编辑器 / 工作台 / 开书对话 / 总览（ribbon 切换；点章节回编辑器）。 */
export type ActiveView = 'editor' | 'workbench' | 'onboard' | 'overview' | 'relations' | 'learn' | 'style' | 'audit'
/** 右栏活动 tab（信息/审阅/机检；编辑器 AI 按钮可驱动切到审阅）。 */
export type RightTab = 'info' | 'review' | 'check'

/** 一次性插入命令（引用直传形态）。每次 requestInsert 产出新令牌对象
 * ——同文本再点也是新引用，watcher 必触发（{text, tick} 靠递增 tick 防同值
 *  短路的职责收进「新对象」本体，tick 字段退役）；「一次性」收敛在 consume：首次
 *  返回文本、此后恒 null，重复消费在类型与运行时同时可见，不留「读后置 null」形态
 *  （丢信号 bug 历史两犯的根源即该形态）。 */
export interface InsertCommand {
  readonly text: string
  /** 消费一次：首次返回 text，此后恒返回 null。 */
  consume(): string | null
}

/** 编辑器查询句柄——EditorView 挂载注册/卸载注销，替代原「选区/光标
 *  两个函数槽各自存 store、各自挂卸」的函数注册表形态。方法为闭包实现（不依赖 this）。 */
export interface EditorHandle {
  /** 当前选区文本（无选区返回空串；「无编辑器」由兼容读面的 null 承担）。 */
  getSelection(): string
  /** 光标在编辑器正文（fm 已剥离）中的偏移；无光标信息返回 null。坐标系 = 编辑器
   *  正文，调用方自行换算全文偏移（口径见 useChapterTreeActions.doSplitHere）。 */
  getCursorOffset(): number | null
}

// ── 模块级件（store setup 的函数体量受行数硬线约束；本区不取 store 实例，
//    所需 ref/回调由调用方直传，行为与内联形态逐位一致） ──

/** 旧 localStorage 键（书级 prefs 一次性迁移源；迁移成功即清）。 */
const LEGACY_UI_PREFS_KEY = 'clw2.ui-prefs'

function legacyWorkspaceKey(name: string): string {
  return `clw2.workspace.${name}`
}

function legacyFileTreeKey(name: string): string {
  return `clw2.filetree.${name}`
}

/** 未知值按记录取键——沿用原 `any` 取值语义（null/undefined 取值即抛，交调用方 catch 降级）。 */
function pick(v: unknown, key: string): unknown {
  return (v as Record<string, unknown>)[key]
}

/** 正数有限守卫（书级覆盖两键共用）：非法值按「无值」处理——服务端 JSON 可表达
 *  1e999→Infinity，手改 prefs.json 可得 0/负数；autosave 零/负间隔原仅靠 Book.vue
 *  max(5,·) 事后兜底，pageWidth 非法值直产非法 CSS 宽度。 */
function posNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** 清书级覆盖值并落实：refs 清空 + apply() 一次（只清 refs 不改 CSS 变量，
 *  --page-width 等 :root 变量仍滞留前书覆盖值）。 */
function clearBookOverrides(): void {
  const ps = usePrefsStore()
  ps.bookPageWidth = null
  ps.bookAutosaveInterval = null
  ps.apply()
}

/** 旧 localStorage → 书级 prefs 一次性迁移（仅 prefs.json 成功读到且为空时调用）。
 *  返回是否发生迁移：true 时写回服务端并清旧键（不清则每次 prefs.json 为空的新书都会
 *  重复走迁移分支；清失败静默，下次重迁移无害）。 */
function migrateLegacyPrefs(prefs: BookPrefs, name: string): boolean {
  let migrated = false
  try {
    const oldUi = localStorage.getItem(LEGACY_UI_PREFS_KEY)
    if (oldUi) {
      const p = JSON.parse(oldUi) as unknown
      const lw = pick(p, 'leftWidth')
      if (typeof lw === 'number') prefs.leftWidth = lw
      const lo = pick(p, 'leftOpen')
      if (typeof lo === 'boolean') prefs.leftOpen = lo
      const ro = pick(p, 'rightOpen')
      if (typeof ro === 'boolean') prefs.rightOpen = ro
      const lp = pick(p, 'leftPanel')
      if (lp === 'tree' || lp === 'search' || lp === 'trash') prefs.leftPanel = lp
    }
    const oldWs = localStorage.getItem(legacyWorkspaceKey(name))
    if (oldWs) {
      const ad = pick(JSON.parse(oldWs) as unknown, 'activeDocId')
      // 只认 string/null——脏值（数字/对象/数组）原样写进 activeDocId 位，
      // 下游按 string|null 消费（已打开的文档 id 与树节点比对）
      if (typeof ad === 'string' || ad === null) prefs.activeDocId = ad
    }
    const oldTree = localStorage.getItem(legacyFileTreeKey(name))
    if (oldTree) {
      const arr = JSON.parse(oldTree) as unknown
      // 迁移元素验 string——非 string 脏值（数字/null/嵌套）过滤掉，
      // 否则树展开渲染按 path 比对时出现无主条目
      if (Array.isArray(arr)) prefs.treeExpanded = arr.filter((x): x is string => typeof x === 'string')
    }
    migrated = Object.keys(prefs).length > 0
  } catch {
    /* 损坏降级 */
  }
  if (migrated) {
    void putBookPrefs(name, prefs).catch(() => {})
    try {
      localStorage.removeItem(LEGACY_UI_PREFS_KEY)
      localStorage.removeItem(legacyWorkspaceKey(name))
      localStorage.removeItem(legacyFileTreeKey(name))
    } catch {
      /* localStorage 不可用降级 */
    }
  }
  return migrated
}

/** 布局域 ref 面（模块级件按此读写，免逐个传参）。 */
interface LayoutTargets {
  leftWidth: Ref<number>
  leftOpen: Ref<boolean>
  rightOpen: Ref<boolean>
  leftPanel: Ref<LeftPanel>
  activeDocId: Ref<string | null>
  treeExpanded: Ref<string[]>
  /** 用户是否手工调过展开态（loadBookPrefs 迟到回填的守卫）。 */
  treeExpandedTouched: () => boolean
}

/** 应用书级 prefs 的布局字段（逐键类型守卫：字段缺失/错型按「不覆盖」处理）。 */
function applyLayoutPrefs(prefs: BookPrefs, t: LayoutTargets): void {
  if (typeof prefs.leftWidth === 'number' && prefs.leftWidth >= 180) t.leftWidth.value = prefs.leftWidth
  if (typeof prefs.leftOpen === 'boolean') t.leftOpen.value = prefs.leftOpen
  if (typeof prefs.rightOpen === 'boolean') t.rightOpen.value = prefs.rightOpen
  if (prefs.leftPanel === 'tree' || prefs.leftPanel === 'search' || prefs.leftPanel === 'trash')
    t.leftPanel.value = prefs.leftPanel
  // prefs 迟到回填仅在当前未打开文档时生效——用户已点开另一文档后被覆盖回 prefs
  // 记录（切书 gen 守卫只防跨书异步竞态，不防同书用户操作）
  if (t.activeDocId.value === null) t.activeDocId.value = prefs.activeDocId ?? null
  // 同款守卫护展开态——用户已展开/折叠过则跳过回填，不覆盖作者意图
  if (Array.isArray(prefs.treeExpanded) && !t.treeExpandedTouched()) t.treeExpanded.value = prefs.treeExpanded
}

/** 书级 prefs 落盘载荷（写时快照：布局字段 + prefs store 的书级覆盖两键）。 */
function snapshotBookPrefs(t: LayoutTargets): BookPrefs {
  const ps = usePrefsStore()
  return {
    leftWidth: t.leftWidth.value,
    leftOpen: t.leftOpen.value,
    rightOpen: t.rightOpen.value,
    leftPanel: t.leftPanel.value,
    activeDocId: t.activeDocId.value,
    treeExpanded: t.treeExpanded.value,
    pageWidth: ps.bookPageWidth ?? undefined,
    autosaveInterval: ps.bookAutosaveInterval ?? undefined,
  }
}

/** 书级 prefs 落盘调度器：500ms 防抖窗 + 在途写句柄 + 关窗冲刷。
 *  行为与内联形态逐位一致：排定时刻快照 gen 与书名、fire 时复查（切书即作废本次落盘）；
 *  冲刷先等在途落定再清窗直发，防两笔 PUT 乱序旧覆盖新。 */
function createPrefsPersistScheduler(opts: {
  guard: { current: () => number; stale: (gen: number) => boolean }
  name: () => string | null
  isLoaded: () => boolean
  snapshot: () => BookPrefs
  /** 落盘失败：同一失败窗只提示一次（成功落盘复位）。 */
  onFail: () => void
  onRecover: () => void
}) {
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 在途写句柄（对齐 prefs.ts 的 putInFlight 单飞槽先例）。链尾只清自己占据的占位。 */
  let inFlight: Promise<void> | null = null

  function write(gen: number, name: string): Promise<void> {
    // 复查：gen/书名任一漂移（切书）→ 本次落盘作废，防 A 书布局写进 B 书
    if (opts.guard.stale(gen) || !opts.isLoaded() || opts.name() !== name) return Promise.resolve()
    const settle = (q: Promise<void>): void => {
      if (inFlight === q) inFlight = null
    }
    const p = putBookPrefs(name, opts.snapshot())
      .then(() => opts.onRecover())
      .catch(() => opts.onFail())
      // settle 闭包运行时 p 已初始化（链回调异步于同步段），读参避免自引用早于赋值
      .finally(() => settle(p))
    // body 起跑即同步占位（对齐 prefs.ts runPutChain 的单飞不变式）
    inFlight = p
    return p
  }

  /** 布局变更 → 排定一次合并写；fire 即置空句柄（冲刷据此判「无待写」）。 */
  function schedule(): void {
    if (!opts.isLoaded()) return
    const name = opts.name()
    if (!name) return
    if (timer) clearTimeout(timer)
    const gen = opts.guard.current()
    timer = setTimeout(() => {
      timer = null
      void write(gen, name)
    }, 500)
  }

  /** 挂起窗作废（切书）：清计时器，本次不写。 */
  function cancel(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }

  /** 关窗冲刷：先等在途落定（失败已消化，不重试）→ 清窗直发一次写穿；无待写项不空写。 */
  async function flush(): Promise<void> {
    if (inFlight)
      await inFlight.catch(() => {
        /* 在途失败已消化，此处不重试 */
      })
    if (!timer) return
    clearTimeout(timer)
    timer = null
    await write(opts.guard.current(), opts.name() ?? '')
  }

  return { write, schedule, cancel, flush }
}

/** 切档时旧文档的存盘链（fire-and-forget，不阻断切换）：
 *  在途落定 → 复查 → 补存一次 → 仅真失败才可见化。 */
function savePrevDocOnSwitch(prevId: string, isSameBook: () => boolean): void {
  const doc = useDocStore()
  // 失败是异步迟到态：不抛错不打断切换；入口书名快照守卫防在途切书后
  // 迟到失败提示落新书界面
  const notify = (): void => {
    if (isSameBook()) useUiStore().toast('切换文档时自动保存失败，未保存内容仍保留', 'warning')
  }
  // dirty 要到保存落定才清，不等在途即判必吃到 save「saving 中 autosave 返 false」
  // 的假失败（flushDirty 同款有界轮次台账等待）
  void (async (): Promise<void> => {
    await doc.waitInflightSave(prevId)
    if (!isSameBook()) return // 切书后迟到落定不落当前界面（下方 get 复查兜底）
    const cur = doc.get(prevId)
    if (!cur || !cur.dirty || cur.saving) return // ① 已 clean / 条目已清（删除、切书）/ 新在途接手 → 不补存不提示
    if (cur.conflict) return // ② 冲突未决（autosave 设计内跳过，编辑器自有重载/覆盖冲突 UI）
    const ok = await doc.save(prevId, 'autosave')
    if (!ok) {
      // ③ save 返 false ≠ 全是失败（条目已清的 404、落定冲突都不算）：
      // 复查仍 dirty、无新在途、非冲突才可见化
      const after = doc.get(prevId)
      if (after?.dirty && !after.saving && !after.conflict) notify()
    }
  })().catch(notify)
}

/** 一次性插入令牌构造（消费态随令牌本体走，不与槽位耦合）。 */
function makeInsertCommand(text: string): InsertCommand {
  let consumed = false
  return {
    text,
    consume(): string | null {
      if (consumed) return null
      consumed = true
      return text
    },
  }
}

/** 兼容读面构造：句柄在场时借出其方法（闭包内直呼，不依赖 this），离场返回 null——
 *  读方 `ws.editorGetSelection?.` 的可选链语义与内联 computed 逐位一致。 */
function handleReader<T>(handle: Ref<EditorHandle | null>, read: (h: EditorHandle) => T): ComputedRef<T | null> {
  return computed<T | null>(() => {
    const h = handle.value
    return h ? read(h) : null
  })
}

/** tree load 后校验：activeDocId 失效则清空（watch 自动持久化）。
 *  属主校验——keyset 是某本书整树的 docId 集合，切书窗内 tree 仍持旧书键集
 *  （byDocId/ownerBook 与 bookName 更不同窗），以旧键集校验新书恢复的 activeDocId
 *  会误清（恢复文档被清，下次进书不再恢复；无内容丢失，体验面）。ownerBook 与当前
 *  书名不一致时跳过校验；缺省（既有调用面/存量测试口径）维持原行为不做属主比对。 */
function validateDocId(
  activeDocId: Ref<string | null>,
  bookName: Ref<string | null>,
  validDocIds: Set<string>,
  ownerBook?: string,
): void {
  if (ownerBook !== undefined && ownerBook !== bookName.value) return
  if (activeDocId.value && !validDocIds.has(activeDocId.value)) activeDocId.value = null
}

/** 新建信号发射（TabBar → ChapterTreePanel 监听 createTick 执行）。
 *  左栏在搜索/回收站时点「新建」此前静默无响应——createTick 唯一消费者
 *  ChapterTreePanel 只在 leftPanel==='tree' 时挂载（SidebarLeft v-if），信号发出时无
 *  监听者。非树面板先切回章节树（新建意图指向树，切面板即用户可见反馈），tick 递延到
 *  nextTick——面板切换触发重新挂载，watch 注册晚于 tick++ 会错过信号（挂载期不
 *  immediate），nextTick 再递一次让挂载后的 watch 收到。 */
function emitCreateSignal(
  kind: CreateKind,
  s: { kind: Ref<CreateKind>; panel: Ref<LeftPanel>; tick: Ref<number> },
): void {
  s.kind.value = kind
  if (s.panel.value !== 'tree') {
    s.panel.value = 'tree'
    void nextTick(() => {
      s.tick.value++
    })
    return
  }
  s.tick.value++
}

/** 书级配置读取结果类型（定义在 shared/book-config-cache，经此处转发给消费方）。 */
export type { BookConfigRead }

/**
 * 工作区状态：面板折叠态 + 当前文档 + 持久化恢复。
 *
 * 三级配置架构（A+B，对齐 Obsidian）：
 * - 全局偏好（主题/字体/字号/行距）→ .clwriting/global.json（跨书共享）
 * - 书级偏好（面板布局/最后文档）→ .clwriting/prefs.json（跟随书）
 * - 章节级（标题/标签）→ frontmatter（不变）
 *
 * 切书时异步加载 .clwriting/prefs.json 恢复布局；变更时 debounce 写回。
 * 首次加载如 prefs.json 不存在，从旧 localStorage 自动迁移。
 *
 * 书级配置（book.yaml）读取也挂在本 store：它已是书级数据的既有载体（bookName +
 * 书级 prefs 生命周期），配置的「读哪本、何时失效」与之同一生命周期——另立第二个
 * store 只会多一份切书协调面。读取口径见 loadBookConfig。
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const leftOpen = ref(true)
  const rightOpen = ref(true)
  /** 左栏宽度（可拖拽调整，最小 180）。 */
  const leftWidth = ref(220)
  const focusMode = ref(false)
  /** 左栏活动面板（细案 §5 leftPanel）。 */
  const leftPanel = ref<LeftPanel>('tree')
  /** 主区活动视图：编辑器 / 工作台 / 开书对话 / 总览（ribbon 切换；点章节回编辑器）。 */
  const activeView = ref<ActiveView>('editor')
  /** 右栏活动 tab（信息/审阅/机检）；编辑器 AI 按钮可驱动切到审阅。 */
  const rightTab = ref<RightTab>('info')
  /** 当前打开的文档 ID（单文档模式，无标签页）。 */
  const activeDocId = ref<string | null>(null)
  /** 章节树展开路径（持久化到 prefs.json）。 */
  const treeExpanded = ref<string[]>(['写作'])
  /** 新建信号（TabBar 触发 → ChapterTreePanel 监听执行）。createKind 标记类型，createTick 递增触发。 */
  const createKind = ref<CreateKind>('chapter')
  const createTick = ref(0)
  /** 待插入命令（右栏速查「插入」→ 编辑器，命令管道）。null = 无待插入；
   *  已消费令牌留槽为惰性（consume 恒 null，watcher 不再触发），切书由 setBook 清槽作废。 */
  const pendingInsert = ref<InsertCommand | null>(null)
  /** 编辑器查询句柄（EditorView onMounted 注册 / onUnmounted 置 null）。null = 无编辑器。 */
  const editorHandle = shallowRef<EditorHandle | null>(null)
  /** 兼容读面（RewritePanel / useAiAssist / useChapterTreeStructure 既有读取口）——
   *  句柄在场借出其方法、离场返回 null；构造口径见 handleReader。 */
  const editorGetSelection = handleReader(editorHandle, (h) => () => h.getSelection())
  const editorGetCursorOffset = handleReader(editorHandle, (h) => () => h.getCursorOffset())
  const bookName = ref<string | null>(null)

  // ── 书级 prefs 加载/持久化状态 ──
  let prefsLoaded = false
  let watchStop: (() => void) | null = null
  /** 切书 generation token：防止快速切换 A→B→C 时 A 的异步 prefs 覆盖 C（竞态污染）。
   * 裸计数器换装 useStaleGuard（setBook begin；其余观测点 current）。 */
  const bookGen = useStaleGuard()
  /** 书级 prefs 持久化失败的一次性提示去重标记——对齐全局偏好口径
   * （同一失败窗只 warning 一次，成功落盘复位） */
  let bookPrefsFailNotified = false
  /** 进书后用户是否动过 treeExpanded（展开/折叠 mutation 处 setTreeExpanded
   * 置位）——loadBookPrefs 迟到回填不得覆盖作者已手工调整的展开态（比照 activeDocId 的
   * 守卫：既有 gen 守卫只防跨书异步竞态，不防同书用户操作） */
  let treeExpandedTouched = false

  /** 布局域 ref 面（模块级件按此读写）。 */
  const layout: LayoutTargets = {
    leftWidth,
    leftOpen,
    rightOpen,
    leftPanel,
    activeDocId,
    treeExpanded,
    treeExpandedTouched: () => treeExpandedTouched,
  }
  /** 书级 prefs 落盘调度器（防抖窗 / 在途写句柄 / 关窗冲刷三件的收拢口）。 */
  const persist = createPrefsPersistScheduler({
    guard: bookGen,
    name: () => bookName.value,
    isLoaded: () => prefsLoaded,
    snapshot: () => snapshotBookPrefs(layout),
    onRecover: () => {
      bookPrefsFailNotified = false // 成功落盘复位——恢复后再失败可再提示
    },
    onFail: () => {
      // 落盘失败不再全静默（原 catch(=>{}) 吞掉——离线调面板布局重启回退无提示）
      if (bookPrefsFailNotified) return
      bookPrefsFailNotified = true
      useUiStore().toast('本书布局偏好暂时未能保存（网络/服务异常），恢复后将随下次调整自动重试', 'warning')
    },
  })

  /** 展开/折叠树节点的唯一用户入口（ChapterTreePanel toggle / 新建自动展开）：
   *  置「用户已操作」位 + 写值。程序化默认展开（首开 defaultExpandedDirs）不走这里。 */
  function setTreeExpanded(paths: string[]): void {
    treeExpandedTouched = true
    treeExpanded.value = paths
  }

  /** 启动 watch：面板布局/文档变更时 debounce 写回 .clwriting/prefs.json。 */
  function startPersistWatch(): void {
    if (watchStop) watchStop()
    const ps = usePrefsStore()
    watchStop = watch(
      [
        leftWidth,
        leftOpen,
        rightOpen,
        leftPanel,
        activeDocId,
        treeExpanded,
        () => ps.bookPageWidth,
        () => ps.bookAutosaveInterval,
      ],
      () => persist.schedule(),
    )
  }

  // ── 书级配置（book.yaml）只读单源 ──
  // 缓存与在途合并的实现收在 shared/book-config-cache（store 侧只留接线与生命周期）；
  // 失效入口 invalidateBookConfig 由三处调用：本窗写入成功、他窗 book-config 失效通知、
  // 进书（setBook）。失效只丢缓存，值仍由下次读取向服务端取。
  const bookConfig = createBookConfigCache()
  const loadBookConfig = bookConfig.load
  const invalidateBookConfig = bookConfig.invalidate

  /** 切书：异步加载书库级 prefs（工作区布局 + 最后打开文档）。 */
  function setBook(name: string): void {
    // 进书即失效本窗该书配置缓存（同名重进也算——离开期间盘上的 book.yaml 可能被
    // 外部或他窗改过）：本次进书重取一遍，书内各消费方共享这次结果。空书名 = 离书，
    // 无书可读，不立空键。
    if (name) invalidateBookConfig(name)
    if (bookName.value === name) return
    bookName.value = name
    prefsLoaded = false
    activeDocId.value = null
    // A 书展开态不带入 B 书——loadBookPrefs 失败路径（不置
    // prefsLoaded）下旧展开路径滞留作用于 B 书树（同名「写作」组直接命中）
    treeExpanded.value = ['写作']
    // 新进书复位「用户已操作」位——上本书的操作不挡本书 prefs 回填
    treeExpandedTouched = false
    // 滞留插入信号随切书作废——非编辑器视图点「插入」后切书，
    // 新书编辑器 tryConsumeInsert 三口会把 A 书设定名插进 B 书正文
    pendingInsert.value = null
    persist.cancel() // 挂起的落盘随切书作废
    const gen = bookGen.begin()
    void loadBookPrefs(gen)
  }

  /** 从 .clwriting/prefs.json 加载书库级偏好；首次为空时从旧 localStorage 迁移。 */
  async function loadBookPrefs(gen = bookGen.current()): Promise<void> {
    if (!bookName.value) return
    let prefs: BookPrefs = {}
    try {
      prefs = await getBookPrefs(bookName.value)
    } catch {
      // 迟到失败先过切书代际守卫——「清残留」语义仅对当前书成立。A 书
      // getBookPrefs 挂起窗内已切到 B 书（B 已成功回填书级覆盖）时，A 的迟到 reject
      // 不得把 B 刚回填的 bookPageWidth/bookAutosaveInterval 清掉（对齐下方成功路径
      // 同款 gen 守卫）。
      if (bookGen.stale(gen)) return
      // 拉取失败直接放弃——不置 prefsLoaded、不 startPersistWatch（下次进书重试），
      // 否则默认布局经持久化 watch 写回覆盖服务端已存的 prefs.json
      clearBookOverrides()
      return
    }

    // 竞态守卫：await 期间若已切到其他书 → 丢弃本次结果，防 A 的 prefs 写入 C 的 slot
    if (bookGen.stale(gen)) return

    // 向后兼容：prefs.json 成功读到且为空时从旧 localStorage 迁移
    //（拉取失败已提前 return，不会误迁移写回）
    if (Object.keys(prefs).length === 0) migrateLegacyPrefs(prefs, bookName.value)

    // 应用 prefs 到 store（布局字段逐键守卫见 applyLayoutPrefs）
    applyLayoutPrefs(prefs, layout)

    // 注入书级覆盖到 prefs store（pageWidth / autosaveInterval）——
    // 两键补「正数有限」守卫（非法值按「无书级覆盖」处理，全局值托底，与字段缺失同口径）
    const ps = usePrefsStore()
    ps.bookPageWidth = posNum(prefs.pageWidth)
    ps.bookAutosaveInterval = posNum(prefs.autosaveInterval)
    ps.apply()

    prefsLoaded = true
    startPersistWatch()
  }

  /** 关窗前强制冲刷书级 prefs 的 500ms 防抖窗——末次布局态
   *  （面板开合/宽度/活动文档/展开态）此前随关窗静默丢失。对齐全局偏好
   *  prefs.flushPendingPersist 的关窗钩子口径（App.vue __clwFlushPrefs 先例）：
   *  清掉挂起计时器后直发一次写穿，整链 Promise 交 Book.vue __clwFlushBeforeClose
   *  await（主进程关窗预算内等待）。防抖语义不变——平时照旧 500ms 合并写；
   *  无待写项（计时器空）不空写，但也等在途写落定（先等再发，防两笔 PUT 乱序）。 */
  async function flushPendingBookPrefs(): Promise<void> {
    await persist.flush()
  }

  /** tree load 后校验：activeDocId 失效则清空（口径见 validateDocId）。 */
  function validate(validDocIds: Set<string>, ownerBook?: string): void {
    validateDocId(activeDocId, bookName, validDocIds, ownerBook)
  }

  /** 打开文档（单文档模式）：切到编辑器视图 + 旧文档 dirty 自动保存（watch 自动持久化）。
   * 存旧文档走 doDelete 同族的「先落定在途再判」——契约下 entry.saving 时
   *  doc.save('autosave') 直接返 false 不等待，原实现在途保存窗口内必误报
   *  「切换文档时自动保存失败」（内容不丢、在途自愈的假警报）。落定复查细节见
   *  savePrevDocOnSwitch。 */
  function openTab(docId: string): void {
    activeView.value = 'editor'
    const prevId = activeDocId.value
    if (prevId && prevId !== docId) {
      const doc = useDocStore()
      // 读 dirty 前先落编辑器防抖尾——正文回写有 ≤200ms 合并窗，
      // 窗内键入未落回 store 时本判式读到 false，存旧文档链整段不启动（内容靠 autosave
      // 节拍兜底，切档即存这条保护在窗口内静默失效）。flush 幂等，落尾按槽内 docId。
      flushBodyWriteback()
      if (doc.get(prevId)?.dirty) {
        const bookAtEntry = bookName.value
        savePrevDocOnSwitch(prevId, () => bookName.value === bookAtEntry)
      }
    }
    activeDocId.value = docId
  }

  /** 触发新建（TabBar → ChapterTreePanel 监听 createTick 执行；kind 标记新建类型）。
   *  非树面板下的切面板与 tick 递延口径见 emitCreateSignal。 */
  function triggerCreate(kind: CreateKind = 'chapter'): void {
    emitCreateSignal(kind, { kind: createKind, panel: leftPanel, tick: createTick })
  }
  /** 请求插入文本到编辑器光标（右栏速查「插入」用）。每次调用产出新一次性令牌
   * （消费态收敛在令牌内，槽位不再承担一次性语义）。 */
  function requestInsert(text: string): void {
    pendingInsert.value = makeInsertCommand(text)
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
  function setLeftPanel(p: LeftPanel): void {
    leftPanel.value = p
    leftOpen.value = true // 从 ribbon 点面板入口时确保左栏打开
  }
  /** 切右栏 tab（编辑器 AI 按钮调用时自动展开右栏）。 */
  function setRightTab(t: RightTab): void {
    rightTab.value = t
    rightOpen.value = true
  }
  function setActiveView(v: ActiveView): void {
    activeView.value = v
  }
  /** 注册/注销编辑器查询句柄（EditorView mount/unmount；选区/光标读取单点注册）。
   * 原 editorGetSelection/editorGetCursorOffset 两个函数槽各自挂卸，
   *  生命周期两条线；读方经上方兼容读面取用，读取口不变。 */
  function setEditorHandle(h: EditorHandle | null): void {
    editorHandle.value = h
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
    loadBookConfig,
    invalidateBookConfig,
    setTreeExpanded,
    validate,
    openTab,
    triggerCreate,
    flushPendingBookPrefs,
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
    editorGetSelection,
    setEditorHandle,
    editorGetCursorOffset,
  }
})
