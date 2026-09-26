import { defineStore } from 'pinia'
import { ref, computed, shallowRef, watch, nextTick } from 'vue'
import { useDocStore } from './doc'
import { usePrefsStore } from './prefs'
import { useUiStore } from './ui'
import { getBookPrefs, putBookPrefs, type BookPrefs } from '../api/prefs'
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
  /** 兼容读面（RewritePanel / useAiAssist / useChapterTreeStructure 既有读取口）：
   *  句柄在场时借出其方法（闭包内直呼，不依赖 this），离场返回 null——读方
   *  `ws.editorGetSelection?.` 的可选链语义与改前逐位一致。 */
  const editorGetSelection = computed<(() => string) | null>(() => {
    const h = editorHandle.value
    return h ? () => h.getSelection() : null
  })
  const editorGetCursorOffset = computed<(() => number | null) | null>(() => {
    const h = editorHandle.value
    return h ? () => h.getCursorOffset() : null
  })
  const bookName = ref<string | null>(null)

  // ── 书库级 prefs 加载/持久化 ──
  let prefsLoaded = false
  let watchStop: (() => void) | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** 切书 generation token：防止快速切换 A→B→C 时 A 的异步 prefs 覆盖 C（竞态污染）。
   * 裸计数器换装 useStaleGuard（setBook begin；其余观测点 current）。 */
  const bookGen = useStaleGuard()
  /** 书级 prefs 持久化失败的一次性提示
   * 去重标记——对齐全局偏好口径（同一失败窗只 warning 一次，成功落盘复位） */
  let bookPrefsFailNotified = false
  /** 书级 prefs 在途写句柄（对齐 prefs.ts 的 putInFlight 单飞槽先例；
   *  书级侧此前无在途面——防抖刚 fire 出去的那笔写不在关窗冲刷等待范围，缺口在
   * 注释挂账待拍板，本批收口）。链尾只清自己占据的占位。 */
  let bookPrefsInFlight: Promise<void> | null = null
  // 进书后用户是否动过 treeExpanded（展开/折叠 mutation 处 setTreeExpanded
  // 置位）——loadBookPrefs 迟到回填不得覆盖作者已手工调整的展开态（比照 activeDocId 的
  // 守卫：既有 gen 守卫只防跨书异步竞态，不防同书用户操作）
  let treeExpandedTouched = false

  /** 展开/折叠树节点的唯一用户入口（ChapterTreePanel toggle / 新建自动展开）：
   *  置「用户已操作」位 + 写值。程序化默认展开（首开 defaultExpandedDirs）不走这里。 */
  function setTreeExpanded(paths: string[]): void {
    treeExpandedTouched = true
    treeExpanded.value = paths
  }

  /** 切书：异步加载书库级 prefs（工作区布局 + 最后打开文档）。 */
  function setBook(name: string): void {
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
    if (debounceTimer) clearTimeout(debounceTimer) // ff 细节#11：挂起的落盘随切书作废
    debounceTimer = null
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
      // 放弃前清书级覆盖值——A 书的纸张宽度/自动保存间隔残留
      // 进 B 书会话直至下次成功加载（活源读取消耗点）。
      const ps = usePrefsStore()
      ps.bookPageWidth = null
      ps.bookAutosaveInterval = null
      // 清了书级覆盖值但缺 apply()——refs 清空只改 store 态，
      // --page-width 等 :root CSS 变量仍滞留 A 书覆盖值，B 书正文宽度沿用前书设置
      // 直至下次成功加载/全局偏好变更才被冲掉。
      ps.apply()
      return
    }

    // 竞态守卫：await 期间若已切到其他书 → 丢弃本次结果，防 A 的 prefs 写入 C 的 slot
    if (bookGen.stale(gen)) return

    // 向后兼容：prefs.json 成功读到且为空时从旧 localStorage 迁移（拉取失败已提前 return，不会误迁移写回）
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
          // 迁移元素验 string——非 string 脏值（数字/null/嵌套）过滤掉，
          // 否则树展开渲染按 path 比对时出现无主条目
          if (Array.isArray(arr)) prefs.treeExpanded = arr.filter((x): x is string => typeof x === 'string')
        }
        migrated = Object.keys(prefs).length > 0
      } catch {
        /* 损坏降级 */
      }
      if (migrated) {
        void putBookPrefs(bookName.value, prefs).catch(() => {})
        // 迁移后清旧键（对齐 prefs store 的 clearLegacyLocalStorage 手法）——
        // 不清则每次 prefs.json 为空的新书都会重复走迁移分支；清失败静默（下次重迁移无害）
        try {
          localStorage.removeItem('clw2.ui-prefs')
          localStorage.removeItem(`clw2.workspace.${bookName.value}`)
          localStorage.removeItem(`clw2.filetree.${bookName.value}`)
        } catch {
          /* localStorage 不可用降级 */
        }
      }
    }

    // 应用 prefs 到 store
    if (typeof prefs.leftWidth === 'number' && prefs.leftWidth >= 180) leftWidth.value = prefs.leftWidth
    if (typeof prefs.leftOpen === 'boolean') leftOpen.value = prefs.leftOpen
    if (typeof prefs.rightOpen === 'boolean') rightOpen.value = prefs.rightOpen
    if (prefs.leftPanel === 'tree' || prefs.leftPanel === 'search' || prefs.leftPanel === 'trash')
      leftPanel.value = prefs.leftPanel
    // prefs 迟到回填仅在当前未打开文档时生效——用户已点开另一
    // 文档后被覆盖回 prefs 记录（既有 gen 守卫只防跨书异步竞态，不防同书用户操作）
    if (activeDocId.value === null) activeDocId.value = prefs.activeDocId ?? null
    // 同款守卫护展开态——用户已展开/折叠过则跳过回填，不覆盖作者意图
    if (Array.isArray(prefs.treeExpanded) && !treeExpandedTouched) treeExpanded.value = prefs.treeExpanded

    // 注入书级覆盖到 prefs store（pageWidth / autosaveInterval）
    const ps = usePrefsStore()
    // 清偿批两键补「正数有限」守卫（对齐 stores/prefs 迁移侧
    // Number.isFinite(v) && v > 0 先例）——原 typeof number 单闸放行 0/负数/Infinity
    //（服务端 JSON 可表达 1e999→Infinity；手改 prefs.json 可得 0/负数）：autosave
    // 零/负间隔此前仅靠 Book.vue max(5,·) 事后兜底，pageWidth 非法值直产非法 CSS
    // 宽度。非法值按「无书级覆盖」（null，全局值托底）处理，与字段缺失同口径。
    const posNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
    ps.bookPageWidth = posNum(prefs.pageWidth)
    ps.bookAutosaveInterval = posNum(prefs.autosaveInterval)
    ps.apply()

    prefsLoaded = true
    startPersistWatch()
  }

  /**
   * 书级 prefs 落盘直发段：按排定时刻快照（gen/name）复查后写穿一次 putBookPrefs。
   * 自防抖 setTimeout 回调外提
   * ——关窗冲刷（flushPendingBookPrefs）与防抖 fire 复用同一段写链（成功复位一次性
   * 失败提示标记 / 失败走一次性 warning，口径不变）。
   */
  function writeBookPrefs(gen: number, name: string): Promise<void> {
    // ff 细节#11 复查：gen/书名任一漂移（切书）→ 本次落盘作废，防 A 书布局写进 B 书
    if (bookGen.stale(gen) || !prefsLoaded || bookName.value !== name) return Promise.resolve()
    const ps = usePrefsStore()
    const settle = (q: Promise<void>): void => {
      if (bookPrefsInFlight === q) bookPrefsInFlight = null
    }
    const p = putBookPrefs(name, {
      leftWidth: leftWidth.value,
      leftOpen: leftOpen.value,
      rightOpen: rightOpen.value,
      leftPanel: leftPanel.value,
      activeDocId: activeDocId.value,
      treeExpanded: treeExpanded.value,
      pageWidth: ps.bookPageWidth ?? undefined,
      autosaveInterval: ps.bookAutosaveInterval ?? undefined,
    })
      .then(() => {
        bookPrefsFailNotified = false // 成功落盘复位——恢复后再失败可再提示
      })
      .catch(() => {
        // 书级 prefs 落盘失败不再
        // 全静默（原 catch(=>{}) 吞掉——离线调面板布局重启回退无提示）；对齐
        // 全局偏好一次性 warning 口径（同失败窗只提示一次，成功复位）
        if (!bookPrefsFailNotified) {
          bookPrefsFailNotified = true
          useUiStore().toast('本书布局偏好暂时未能保存（网络/服务异常），恢复后将随下次调整自动重试', 'warning')
        }
      })
      // settle 闭包运行时 p 已初始化（链回调异步于同步段），读参避免自引用早于赋值
      .finally(() => settle(p))
    // body 起跑即同步占位（对齐 prefs.ts runPutChain 的单飞不变式）
    bookPrefsInFlight = p
    return p
  }

  /**
   * 关窗前强制冲刷书级 prefs 的
   * 500ms 防抖窗——末次布局态（面板开合/宽度/活动文档/展开态）此前随关窗静默丢失
   * （备案的取舍，本批收口）。对齐全局偏好 prefs.flushPendingPersist 的关窗
   * 钩子口径（App.vue __clwFlushPrefs 先例）：清掉挂起计时器后直发一次写穿，整链
   * Promise 交 Book.vue __clwFlushBeforeClose await（主进程关窗预算内等待）。防抖
   * 语义不变——平时照旧 500ms 合并写；无待写项（计时器空）不空写。
   * 配合防抖 fire 分支置空句柄，
   *  本守卫才真正兑现（此前 fire 后句柄恒非 null，保存过一次的书每次关窗仍空写）。
   * 原挂账的「已知边界」收口
   *  ——书级侧补建在途写句柄（bookPrefsInFlight），本冲刷先等在途写落定再清窗直发
   *  （先等再发，防两笔 PUT 乱序到达旧布局覆盖新布局）；防抖窗空时也等在途——关窗
   *  钩子「冲刷完成才销毁窗口」的语义自此覆盖刚 fire 出去的那笔写，不随窗夭折。
   */
  async function flushPendingBookPrefs(): Promise<void> {
    if (bookPrefsInFlight)
      await bookPrefsInFlight.catch(() => {
        /* 在途失败已消化，此处不重试 */
      })
    if (!debounceTimer) return
    clearTimeout(debounceTimer)
    debounceTimer = null
    await writeBookPrefs(bookGen.current(), bookName.value ?? '')
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
      () => {
        if (!prefsLoaded || !bookName.value) return
        if (debounceTimer) clearTimeout(debounceTimer)
        // ff 细节#11：捕获排定时刻的书，fire 时复查（500ms 内切书 → 本次落盘作废，
        // 防 A 书布局经 setTimeout 回调写进 B 书 prefs.json）
        const gen = bookGen.current()
        const name = bookName.value
        debounceTimer = setTimeout(() => {
          // fire 即置空句柄——此前
          // 回调执行完不清空，句柄停在旧定时器上恒非 null，而 flushPendingBookPrefs 以
          // `!debounceTimer` 作「无待写」判据（立的守卫），于是保存过一次
          // 的书每次关窗都同值空写 prefs.json（与 prefs.ts persistTimer 同型缺口，两处
          // 同批收口）；服务端侧表现同为 revision 空 bump + 其他窗伪 409。
          debounceTimer = null
          void writeBookPrefs(gen, name)
        }, 500)
      },
    )
  }

  /** tree load 后校验：activeDocId 失效则清空（watch 自动持久化）。
   *  清偿erBook 属主校验——keyset 是某本书整树的 docId 集合，
   * 切书窗内 tree 仍持旧书键集（byDocId/ownerBook 与 bookName 更不同窗），
   *  以旧键集校验新书恢复的 activeDocId 会误清（恢复文档被清，下次进书不再恢复；
   *  无内容丢失，体验面）。ownerBook 与当前书名不一致时跳过校验；缺省（既有调用面/
   *  存量测试口径）维持原行为不做属主比对。 */
  function validate(validDocIds: Set<string>, ownerBook?: string): void {
    if (ownerBook !== undefined && ownerBook !== bookName.value) return
    if (activeDocId.value && !validDocIds.has(activeDocId.value)) {
      activeDocId.value = null
    }
  }

  /** 打开文档（单文档模式）：切到编辑器视图 + 旧文档 dirty 自动保存（watch 自动持久化）。
   * ②：存旧文档改走 doDelete
   * 同族的「先落定在途再判」——契约下 entry.saving 时 doc.save('autosave') 直接返
   *  false 不等待，原实现在途保存窗口内必误报「切换文档时自动保存失败」（内容不丢、
   *  在途自愈的假警报）。先 await doc.waitInflightSave（flushDirty 同款有界轮次台账等待）
   *  落定，复查仍 dirty 才补存；真失败（返 false 且仍 dirty、无新在途）才可见化。
   * （mac 线，merge 同题双修并入）：save 返 false 另有 conflict
   *  一路（autosave 设计内跳过）——冲突未决不补存不提示（编辑器自有重载/覆盖冲突 UI），
   *  判式补 !conflict；切书早退守卫显式化（复查前先对 bookAtEntry 复核）。 */
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
        // 清偿-切换autosave失败可见化：fire-and-forget 存旧文档
        // 失败零 UI 面（save 吞错以 resolved false 上报，被 void 丢弃；编辑器状态条已随
        // 切文档离屏）。失败是异步迟到态：不抛错不打断切换（activeDocId 已先行更新，
        // 旧 id 以 prevId 快照携带进异步链）；入口书名快照守卫防在途切书后迟到失败提示
        // 落新书界面（对齐 doc.save / 同款纪律）。dirty 标志与崩溃镜像兜底
        // 均在（doc.save 失败路径自持），此处仅可见化。
        const bookAtEntry = bookName.value
        const notify = (): void => {
          if (bookName.value === bookAtEntry) {
            useUiStore().toast('切换文档时自动保存失败，未保存内容仍保留', 'warning')
          }
        }
        // ②（win）/ （mac）同题双修并合：整链异步 fire-and-forget
        // 不阻断切换（openTab 保持同步返回）。先落定在途再判（与 doDelete 同族）：
        // ① 落定已 clean（在途已代存）/ 条目已清（删除/切书）/ 又有新在途接手（结局自担，
        //    autosaveTick 节拍兜底）→ 不补存不提示；
        // ② conflict 未决（autosave 设计内跳过，编辑器自有重载/覆盖冲突 UI）→ 不补存不提示；
        // ③ 仍 dirty → 补存一次，仅判式（返 false 且仍 dirty、无新在途、非冲突）
        //    才可见化（save 返 false ≠ 全是失败：条目已清的 404、落定冲突都不算）。
        // reject 兜底沿用 notify（save 正常吞错不拒，契约外 reject 也可见化且不产生
        // unhandled rejection）。
        void (async (): Promise<void> => {
          // dirty 要到保存落定才清，不等在途即判必吃到 save「saving 中 autosave 返 false」
          // 的假失败（flushDirty 同款有界轮次台账等待）
          await doc.waitInflightSave(prevId)
          if (bookName.value !== bookAtEntry) return // 切书后迟到落定不落当前界面（下方 get 复查兜底）
          const cur = doc.get(prevId)
          if (!cur || !cur.dirty || cur.saving) return
          if (cur.conflict) return // 冲突未决不弹本警报（编辑器自有冲突 UI，mac 线三分支②）
          const ok = await doc.save(prevId, 'autosave')
          if (!ok) {
            const after = doc.get(prevId)
            if (after?.dirty && !after.saving && !after.conflict) notify()
          }
        })().catch(notify)
      }
    }
    activeDocId.value = docId
  }

  /** 触发新建（TabBar → ChapterTreePanel 监听 createTick 执行；kind 标记新建类型）。
   * 左栏在搜索/回收站时点「新建」此前静默无响应——
   *  createTick 唯一消费者 ChapterTreePanel 只在 leftPanel==='tree' 时挂载（SidebarLeft
   *  v-if），信号发出时无监听者。修复：非树面板先切回章节树（新建意图指向树，切面板
   *  即用户可见反馈），tick 递延到 nextTick——面板切换触发重新挂载，watch 注册晚于
   *  tick++ 会错过信号（挂载期不 immediate），nextTick 再递一次让挂载后的 watch 收到。 */
  function triggerCreate(kind: CreateKind = 'chapter'): void {
    createKind.value = kind
    if (leftPanel.value !== 'tree') {
      leftPanel.value = 'tree'
      nextTick(() => {
        createTick.value++
      })
      return
    }
    createTick.value++
  }
  /** 请求插入文本到编辑器光标（右栏速查「插入」用）。每次调用产出新一次性令牌
   * （消费态收敛在令牌内，槽位不再承担一次性语义）。 */
  function requestInsert(text: string): void {
    let consumed = false
    pendingInsert.value = {
      text,
      consume(): string | null {
        if (consumed) return null
        consumed = true
        return text
      },
    }
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
