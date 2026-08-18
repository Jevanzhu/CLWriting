import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getGlobalPrefs, putGlobalPrefs, type GlobalPrefs } from '../api/prefs'
import type { ThemeId } from '../types/theme'

/**
 * 全局编辑器偏好 store（主题 + 排版 + 字体 + 书架视图 + 版本保留全局默认）。
 *
 * 存储：userData/global.json（APP 级，跨书库共享；对齐 Obsidian 全局配置）。
 * 替代旧 localStorage（LevelDB 黑盒，不可编辑不可备份）。
 *
 * 书级覆盖：pageWidth / autosaveInterval 可被 .clwriting/prefs.json 覆盖。
 * effectivePageWidth = 书级 > 全局；apply() 用有效值。
 * 书级覆盖的持久化由 workspace store 统一写入 prefs.json（避免双写冲突）。
 *
 * 版本保留全局默认（snapDays/snapCount → 持久化为 global.json 的 snapMaxDays/snapMaxCount）：
 * 生效链 book.yaml snapshots → 此处 → 硬编码 14 天 / 30 个（服务端 prune 同链）。
 * 书级覆盖存 book.yaml 的 snapshots 段（「本书」页写），不进本 store。
 *
 * 书级设定全局托底（13 键，同 snapMax* 模式）：题材/每卷章数/目标字数/每章字数/短篇严格/
 * 文风注入/自动确认细纲/批量章数/单章上限/自动梳理/增量阈值/启用检索/检索提供方。
 * 生效链 book.yaml 对应键 → 此处 → 硬编码回落（ref 初值即回落，服务端合并同链）；
 * 书级覆盖存 book.yaml（「本书」页各领域的「本书使用独立设定」组开关写），不进本 store。
 *
 * 初始化：main.ts 在 mount 前 await init() → API 读取 → apply CSS 变量。
 * 首次为空时从旧 localStorage 自动迁移。
 */
const DEFAULTS = {
  theme: 'light' as ThemeId,
  proseSize: 17,
  proseLh: 1.85,
  pageWidth: 1020,
  autosaveInterval: 30,
  shelfView: 'grid' as 'grid' | 'list',
  chatEnabled: false,
  compact: false,
  snapDays: 14,
  snapCount: 30,
  // ── 书级设定全局托底（书级未设时的展示/生效回落；与服务端合并链末端一致）──
  defaultGenre: '',
  defaultVolumeSize: 50,
  defaultTargetWords: 0,
  defaultChapterTargetWords: 0,
  defaultShortStrict: false,
  styleInjection: 'light' as 'light' | 'heavy',
  autoConfirmOutline: false,
  autoBatchSize: 8,
  callsPerChapter: 8,
  relationAutoMine: false,
  relationMineThreshold: 3,
  ragEnabled: false,
  ragProvider: '',
}

/** 旧 localStorage 键（仅迁移用，迁移后停用） */
const OLD_LS = {
  theme: 'clw-theme',
  size: 'clw.proseSize',
  lh: 'clw.proseLh',
  uiFontCn: 'clw.uiFontCn',
  uiFontEn: 'clw.uiFontEn',
  proseFontCn: 'clw.proseFontCn',
  proseFontEn: 'clw.proseFontEn',
  pageWidth: 'clw.pageWidth',
  autosaveInterval: 'clw.autosaveInterval',
  shelfView: 'clw-shelf-view',
}

/** 拼字体族：英文字体优先（英文片段），中文字体兜底（中文），最后系统 fallback。
 *  含空格的字体名自动加引号。 */
function buildFontFamily(en: string, cn: string, fallback: string): string {
  const parts: string[] = []
  if (en) parts.push(en.includes(' ') ? `"${en}"` : en)
  if (cn) parts.push(cn.includes(' ') ? `"${cn}"` : cn)
  parts.push(fallback)
  return parts.join(', ')
}

export const usePrefsStore = defineStore('prefs', () => {
  // ── 全局偏好（global.json）──
  const theme = ref<ThemeId>(DEFAULTS.theme)
  const proseSize = ref(DEFAULTS.proseSize)
  const proseLh = ref(DEFAULTS.proseLh)
  const uiFontCn = ref('')
  const uiFontEn = ref('')
  const proseFontCn = ref('')
  const proseFontEn = ref('')
  const pageWidth = ref(DEFAULTS.pageWidth)
  const autosaveInterval = ref(DEFAULTS.autosaveInterval)
  const shelfView = ref<'grid' | 'list'>(DEFAULTS.shelfView)
  /** 对话助手开关（默认关闭） */
  const chatEnabled = ref(DEFAULTS.chatEnabled)
  /** 紧凑模式：收窄侧栏间距 / 减小列表行高（默认关闭） */
  const compact = ref(DEFAULTS.compact)
  /** 版本保留全局默认（天数/数量；持久化为 snapMaxDays/snapMaxCount，未单独设定的书使用） */
  const snapDays = ref(DEFAULTS.snapDays)
  const snapCount = ref(DEFAULTS.snapCount)

  // ── 书级设定全局托底（书级 book.yaml 未设时的展示/生效值；持久化为 global.json 13 键）──
  // ref 初值即硬编码回落：前端消费者直接读 ref，书级未设时自然落到这里（服务端合并链末端一致），
  // 无需再写一遍魔法数字。书级覆盖由「本书」页各领域的「本书使用独立设定」组开关写 book.yaml，不进本 store。
  /** 题材默认（'' = 未设；书级 book.genre） */
  const defaultGenre = ref(DEFAULTS.defaultGenre)
  /** 每卷章数默认（仅长篇使用；书级 book.volume_size） */
  const defaultVolumeSize = ref(DEFAULTS.defaultVolumeSize)
  /** 目标字数默认（0 = 未设；书级 book.target_words） */
  const defaultTargetWords = ref(DEFAULTS.defaultTargetWords)
  /** 每章字数默认（0 = 未设；书级 book.chapter_target_words） */
  const defaultChapterTargetWords = ref(DEFAULTS.defaultChapterTargetWords)
  /** 短篇严格模式默认（仅短篇书生效；书级 short.strict） */
  const defaultShortStrict = ref(DEFAULTS.defaultShortStrict)
  /** 文风注入强度默认（书级 style.injection） */
  const styleInjection = ref(DEFAULTS.styleInjection)
  /** 自动确认细纲默认（书级 auto.confirm_outline） */
  const autoConfirmOutline = ref(DEFAULTS.autoConfirmOutline)
  /** 批量写作章数默认（书级 auto.batch_size；注意 ref 名与 JSON 键 autoBatchSize 不同，避免与语义混淆） */
  const aiBatchSize = ref(DEFAULTS.autoBatchSize)
  /** 单章调用上限默认（书级 budget.calls_per_chapter） */
  const callsPerChapter = ref(DEFAULTS.callsPerChapter)
  /** 关系图自动梳理默认（书级 auto.relation_auto_mine） */
  const relationAutoMine = ref(DEFAULTS.relationAutoMine)
  /** 关系图章节增量阈值默认（书级 auto.relation_mine_threshold） */
  const relationMineThreshold = ref(DEFAULTS.relationMineThreshold)
  /** 知识检索启用默认（书级 rag.enabled） */
  const ragEnabled = ref(DEFAULTS.ragEnabled)
  /** 知识检索提供方默认（'' = 未设；书级 rag.provider，引用应用级 RAG 提供方 id） */
  const ragProvider = ref(DEFAULTS.ragProvider)

  // ── 书级覆盖（prefs.json；null = 用全局）──
  const bookPageWidth = ref<number | null>(null)
  const bookAutosaveInterval = ref<number | null>(null)

  // ── 有效值（书级 > 全局）──
  const effectivePageWidth = computed(() => bookPageWidth.value ?? pageWidth.value)
  const effectiveAutosaveInterval = computed(() => bookAutosaveInterval.value ?? autosaveInterval.value)

  let persistTimer: ReturnType<typeof setTimeout> | null = null

  /** 异步初始化：从 global.json 加载（替代 localStorage）。
   *  首次为空时从旧 localStorage 自动迁移。main.ts 在 mount 前调一次。 */
  async function init(): Promise<void> {
    let prefs: GlobalPrefs = {}
    try {
      prefs = await getGlobalPrefs()
    } catch {
      /* API 不可达用默认 */
    }

    // 迁移：prefs 为空（首次）时从旧 localStorage 读取
    if (Object.keys(prefs).length === 0 && migrateFromLocalStorage()) {
      prefs = buildCache()
      void putGlobalPrefs(prefs).catch(() => {})
    } else {
      applyPrefs(prefs)
    }

    applyTheme()
    applyCompact()
    apply()
  }

  /** 从旧 localStorage 迁移到 ref（仅首次 cache 为空时调）。返回是否有迁移数据。 */
  function migrateFromLocalStorage(): boolean {
    let has = false
    try {
      const t = localStorage.getItem(OLD_LS.theme)
      if (t === 'dark' || t === 'light') { theme.value = t; has = true }
      const num = (k: string): number | null => {
        const v = Number(localStorage.getItem(k))
        return Number.isFinite(v) && v > 0 ? v : null
      }
      const str = (k: string): string => localStorage.getItem(k) ?? ''
      for (const [k, ref, kind] of [
        [OLD_LS.size, proseSize, 'num'], [OLD_LS.lh, proseLh, 'num'],
        [OLD_LS.pageWidth, pageWidth, 'num'],
        [OLD_LS.autosaveInterval, autosaveInterval, 'num'],
        [OLD_LS.uiFontCn, uiFontCn, 'str'], [OLD_LS.uiFontEn, uiFontEn, 'str'],
        [OLD_LS.proseFontCn, proseFontCn, 'str'], [OLD_LS.proseFontEn, proseFontEn, 'str'],
      ] as const) {
        if (kind === 'num') {
          const v = num(k)
          if (v !== null) { (ref as typeof proseSize).value = v; has = true }
        } else {
          const v = str(k)
          if (v) { (ref as typeof uiFontCn).value = v; has = true }
        }
      }
      const sv = localStorage.getItem(OLD_LS.shelfView)
      if (sv === 'grid' || sv === 'list') { shelfView.value = sv; has = true }
    } catch { /* localStorage 损坏降级 */ }
    return has
  }

  /** 将 API 读到的 prefs 应用到各 ref */
  function applyPrefs(p: GlobalPrefs): void {
    if (p.theme === 'dark' || p.theme === 'light') theme.value = p.theme
    if (typeof p.proseSize === 'number' && p.proseSize > 0) proseSize.value = p.proseSize
    if (typeof p.proseLh === 'number' && p.proseLh > 0) proseLh.value = p.proseLh
    if (typeof p.uiFontCn === 'string') uiFontCn.value = p.uiFontCn
    if (typeof p.uiFontEn === 'string') uiFontEn.value = p.uiFontEn
    if (typeof p.proseFontCn === 'string') proseFontCn.value = p.proseFontCn
    if (typeof p.proseFontEn === 'string') proseFontEn.value = p.proseFontEn
    if (typeof p.pageWidth === 'number' && p.pageWidth > 0) pageWidth.value = p.pageWidth
    if (typeof p.autosaveInterval === 'number' && p.autosaveInterval > 0) autosaveInterval.value = p.autosaveInterval
    if (p.shelfView === 'grid' || p.shelfView === 'list') shelfView.value = p.shelfView
    if (typeof p.chatEnabled === 'boolean') chatEnabled.value = p.chatEnabled
    if (typeof p.compact === 'boolean') compact.value = p.compact
    if (typeof p.snapMaxDays === 'number' && p.snapMaxDays > 0) snapDays.value = p.snapMaxDays
    if (typeof p.snapMaxCount === 'number' && p.snapMaxCount > 0) snapCount.value = p.snapMaxCount
    // 书级设定全局托底 13 键：逐键类型/范围守卫（global.json 手改脏值不进 UI，保持回落）
    if (typeof p.defaultGenre === 'string') defaultGenre.value = p.defaultGenre.trim()
    if (typeof p.defaultVolumeSize === 'number' && p.defaultVolumeSize >= 5) defaultVolumeSize.value = Math.round(p.defaultVolumeSize)
    // 目标字数/每章字数：JSON 层只存正整数（0 = 未设由 ref 初值表达），非法值回保持现值
    if (typeof p.defaultTargetWords === 'number' && p.defaultTargetWords > 0) defaultTargetWords.value = Math.round(p.defaultTargetWords)
    if (typeof p.defaultChapterTargetWords === 'number' && p.defaultChapterTargetWords > 0) defaultChapterTargetWords.value = Math.round(p.defaultChapterTargetWords)
    if (typeof p.defaultShortStrict === 'boolean') defaultShortStrict.value = p.defaultShortStrict
    if (p.styleInjection === 'light' || p.styleInjection === 'heavy') styleInjection.value = p.styleInjection
    if (typeof p.autoConfirmOutline === 'boolean') autoConfirmOutline.value = p.autoConfirmOutline
    if (typeof p.autoBatchSize === 'number' && p.autoBatchSize >= 1) aiBatchSize.value = Math.round(p.autoBatchSize)
    if (typeof p.callsPerChapter === 'number' && p.callsPerChapter >= 1) callsPerChapter.value = Math.round(p.callsPerChapter)
    if (typeof p.relationAutoMine === 'boolean') relationAutoMine.value = p.relationAutoMine
    if (typeof p.relationMineThreshold === 'number' && p.relationMineThreshold >= 1) relationMineThreshold.value = Math.round(p.relationMineThreshold)
    if (typeof p.ragEnabled === 'boolean') ragEnabled.value = p.ragEnabled
    if (typeof p.ragProvider === 'string') ragProvider.value = p.ragProvider.trim()
  }

  /** 从当前全局 ref 构建 GlobalPrefs 对象（不含书级覆盖） */
  function buildCache(): GlobalPrefs {
    return {
      theme: theme.value,
      proseSize: proseSize.value,
      proseLh: proseLh.value,
      uiFontCn: uiFontCn.value,
      uiFontEn: uiFontEn.value,
      proseFontCn: proseFontCn.value,
      proseFontEn: proseFontEn.value,
      pageWidth: pageWidth.value,
      autosaveInterval: autosaveInterval.value,
      shelfView: shelfView.value,
      chatEnabled: chatEnabled.value,
      compact: compact.value,
      snapMaxDays: snapDays.value,
      snapMaxCount: snapCount.value,
      // 书级设定全局托底 13 键全量带上（global.json 整文件重写，漏键 = 丢配置）
      defaultGenre: defaultGenre.value,
      defaultVolumeSize: defaultVolumeSize.value,
      defaultTargetWords: defaultTargetWords.value,
      defaultChapterTargetWords: defaultChapterTargetWords.value,
      defaultShortStrict: defaultShortStrict.value,
      styleInjection: styleInjection.value,
      autoConfirmOutline: autoConfirmOutline.value,
      autoBatchSize: aiBatchSize.value,
      callsPerChapter: callsPerChapter.value,
      relationAutoMine: relationAutoMine.value,
      relationMineThreshold: relationMineThreshold.value,
      ragEnabled: ragEnabled.value,
      ragProvider: ragProvider.value,
    }
  }

  /** debounce 写回 global.json（500ms） */
  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer)
    const cache = buildCache()
    persistTimer = setTimeout(() => {
      void putGlobalPrefs(cache).catch(() => {})
    }, 500)
  }

  // ── apply（直写 :root CSS 变量）──

  function apply(): void {
    const r = document.documentElement
    r.style.setProperty('--prose-size', `${proseSize.value}px`)
    r.style.setProperty('--prose-lh', String(proseLh.value))
    r.style.setProperty('--page-width', `${effectivePageWidth.value}px`)
    if (uiFontCn.value || uiFontEn.value) {
      r.style.setProperty('--font-ui', buildFontFamily(uiFontEn.value, uiFontCn.value, 'system-ui, sans-serif'))
    } else {
      r.style.removeProperty('--font-ui')
    }
    if (proseFontCn.value || proseFontEn.value) {
      r.style.setProperty('--prose-font', buildFontFamily(proseFontEn.value, proseFontCn.value, "'LXGW WenKai', 'Noto Serif SC', serif"))
    } else {
      r.style.removeProperty('--prose-font')
    }
  }

  function applyTheme(): void {
    document.documentElement.dataset.theme = theme.value
  }

  /** 紧凑模式：给 <html> 挂 .compact，全局 CSS 用该选择器收窄间距 */
  function applyCompact(): void {
    document.documentElement.classList.toggle('compact', compact.value)
  }

  // ── setter ──

  function setThemeValue(id: ThemeId): void {
    theme.value = id
    applyTheme()
    schedulePersist()
  }
  function setSize(v: number): void {
    proseSize.value = v
    apply()
    schedulePersist()
  }
  function setLh(v: number): void {
    proseLh.value = v
    apply()
    schedulePersist()
  }
  function setUiFontCn(v: string): void {
    uiFontCn.value = v
    apply()
    schedulePersist()
  }
  function setUiFontEn(v: string): void {
    uiFontEn.value = v
    apply()
    schedulePersist()
  }
  function setProseFontCn(v: string): void {
    proseFontCn.value = v
    apply()
    schedulePersist()
  }
  function setProseFontEn(v: string): void {
    proseFontEn.value = v
    apply()
    schedulePersist()
  }
  /** 纸张宽度：bookOnly=true 写书级覆盖，false 写全局默认（清除覆盖） */
  function setPageWidth(v: number, bookOnly = false): void {
    if (bookOnly) {
      bookPageWidth.value = v
    } else {
      pageWidth.value = v
      bookPageWidth.value = null
    }
    apply()
    schedulePersist()
  }
  /** 自动保存间隔：bookOnly=true 写书级覆盖，false 写全局默认（清除覆盖） */
  function setAutosaveInterval(v: number, bookOnly = false): void {
    if (bookOnly) {
      bookAutosaveInterval.value = v
    } else {
      autosaveInterval.value = v
      bookAutosaveInterval.value = null
    }
    schedulePersist()
  }
  function setShelfView(v: 'grid' | 'list'): void {
    shelfView.value = v
    schedulePersist()
  }
  function setChatEnabled(v: boolean): void {
    chatEnabled.value = v
    schedulePersist()
  }
  function setCompact(v: boolean): void {
    compact.value = v
    applyCompact()
    schedulePersist()
  }
  /** 版本保留全局默认 · 保留天数（clamp 1-365；未单独设定的书使用） */
  function setSnapDays(v: number): void {
    snapDays.value = Math.min(365, Math.max(1, Math.round(v)))
    schedulePersist()
  }
  /** 版本保留全局默认 · 保留数量（clamp 1-200；未单独设定的书使用） */
  function setSnapCount(v: number): void {
    snapCount.value = Math.min(200, Math.max(1, Math.round(v)))
    schedulePersist()
  }

  // ── 书级设定全局托底 setter（clamp 后写 ref → 走 schedulePersist 防抖落 global.json）──

  /** 写作默认 · 题材（trim；'' = 未设） */
  function setDefaultGenre(v: string): void {
    defaultGenre.value = v.trim()
    schedulePersist()
  }
  /** 写作默认 · 每卷章数（clamp 5-500 取整；仅长篇使用） */
  function setDefaultVolumeSize(v: number): void {
    defaultVolumeSize.value = Math.min(500, Math.max(5, Math.round(v)))
    schedulePersist()
  }
  /** 写作默认 · 目标字数（0 = 未设，否则正整数） */
  function setDefaultTargetWords(v: number): void {
    defaultTargetWords.value = Math.max(0, Math.round(v))
    schedulePersist()
  }
  /** 写作默认 · 每章字数（0 = 未设，否则正整数） */
  function setDefaultChapterTargetWords(v: number): void {
    defaultChapterTargetWords.value = Math.max(0, Math.round(v))
    schedulePersist()
  }
  /** AI 机检 · 短篇严格模式（仅短篇书生效） */
  function setDefaultShortStrict(v: boolean): void {
    defaultShortStrict.value = v
    schedulePersist()
  }
  /** AI 写作 · 文风注入强度 */
  function setStyleInjection(v: 'light' | 'heavy'): void {
    styleInjection.value = v
    schedulePersist()
  }
  /** AI 写作 · 自动确认细纲 */
  function setAutoConfirmOutline(v: boolean): void {
    autoConfirmOutline.value = v
    schedulePersist()
  }
  /** AI 写作 · 批量写作章数（clamp 1-20 取整） */
  function setAiBatchSize(v: number): void {
    aiBatchSize.value = Math.min(20, Math.max(1, Math.round(v)))
    schedulePersist()
  }
  /** AI 写作 · 单章调用上限（clamp 1-50 取整） */
  function setCallsPerChapter(v: number): void {
    callsPerChapter.value = Math.min(50, Math.max(1, Math.round(v)))
    schedulePersist()
  }
  /** 关系图 · 自动梳理 */
  function setRelationAutoMine(v: boolean): void {
    relationAutoMine.value = v
    schedulePersist()
  }
  /** 关系图 · 章节增量阈值（clamp 1-20 取整） */
  function setRelationMineThreshold(v: number): void {
    relationMineThreshold.value = Math.min(20, Math.max(1, Math.round(v)))
    schedulePersist()
  }
  /** 知识检索 · 启用 */
  function setRagEnabled(v: boolean): void {
    ragEnabled.value = v
    schedulePersist()
  }
  /** 知识检索 · 提供方（trim；'' = 未设） */
  function setRagProvider(v: string): void {
    ragProvider.value = v.trim()
    schedulePersist()
  }

  return {
    theme,
    proseSize,
    proseLh,
    uiFontCn,
    uiFontEn,
    proseFontCn,
    proseFontEn,
    pageWidth,
    autosaveInterval,
    shelfView,
    chatEnabled,
    compact,
    snapDays,
    snapCount,
    defaultGenre,
    defaultVolumeSize,
    defaultTargetWords,
    defaultChapterTargetWords,
    defaultShortStrict,
    styleInjection,
    autoConfirmOutline,
    aiBatchSize,
    callsPerChapter,
    relationAutoMine,
    relationMineThreshold,
    ragEnabled,
    ragProvider,
    bookPageWidth,
    bookAutosaveInterval,
    effectivePageWidth,
    effectiveAutosaveInterval,
    init,
    apply,
    applyTheme,
    applyCompact,
    setThemeValue,
    setSize,
    setLh,
    setUiFontCn,
    setUiFontEn,
    setProseFontCn,
    setProseFontEn,
    setPageWidth,
    setAutosaveInterval,
    setShelfView,
    setChatEnabled,
    setCompact,
    setSnapDays,
    setSnapCount,
    setDefaultGenre,
    setDefaultVolumeSize,
    setDefaultTargetWords,
    setDefaultChapterTargetWords,
    setDefaultShortStrict,
    setStyleInjection,
    setAutoConfirmOutline,
    setAiBatchSize,
    setCallsPerChapter,
    setRelationAutoMine,
    setRelationMineThreshold,
    setRagEnabled,
    setRagProvider,
  }
})
