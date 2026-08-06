import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getGlobalPrefs, putGlobalPrefs, type GlobalPrefs } from '../api/prefs'
import type { ThemeId } from '../types/theme'

/**
 * 全局编辑器偏好 store（主题 + 排版 + 字体 + 书架视图）。
 *
 * 存储：userData/global.json（APP 级，跨书库共享；对齐 Obsidian 全局配置）。
 * 替代旧 localStorage（LevelDB 黑盒，不可编辑不可备份）。
 *
 * 书级覆盖：pageWidth / autosaveInterval 可被 .clwriting/prefs.json 覆盖。
 * effectivePageWidth = 书级 > 全局；apply() 用有效值。
 * 书级覆盖的持久化由 workspace store 统一写入 prefs.json（避免双写冲突）。
 *
 * 初始化：main.ts 在 mount 前 await init() → API 读取 → apply CSS 变量。
 * 首次为空时从旧 localStorage 自动迁移。
 */
const DEFAULTS = {
  theme: 'light' as ThemeId,
  proseSize: 17,
  proseLh: 1.85,
  proseGap: 1,
  pageWidth: 1020,
  autosaveInterval: 30,
  shelfView: 'grid' as 'grid' | 'list',
  chatEnabled: false,
  compact: false,
}

/** 旧 localStorage 键（仅迁移用，迁移后停用） */
const OLD_LS = {
  theme: 'clw-theme',
  size: 'clw.proseSize',
  lh: 'clw.proseLh',
  gap: 'clw.proseGap',
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
  const proseGap = ref(DEFAULTS.proseGap)
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
        [OLD_LS.gap, proseGap, 'num'], [OLD_LS.pageWidth, pageWidth, 'num'],
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
    if (typeof p.proseGap === 'number' && p.proseGap > 0) proseGap.value = p.proseGap
    if (typeof p.uiFontCn === 'string') uiFontCn.value = p.uiFontCn
    if (typeof p.uiFontEn === 'string') uiFontEn.value = p.uiFontEn
    if (typeof p.proseFontCn === 'string') proseFontCn.value = p.proseFontCn
    if (typeof p.proseFontEn === 'string') proseFontEn.value = p.proseFontEn
    if (typeof p.pageWidth === 'number' && p.pageWidth > 0) pageWidth.value = p.pageWidth
    if (typeof p.autosaveInterval === 'number' && p.autosaveInterval > 0) autosaveInterval.value = p.autosaveInterval
    if (p.shelfView === 'grid' || p.shelfView === 'list') shelfView.value = p.shelfView
    if (typeof p.chatEnabled === 'boolean') chatEnabled.value = p.chatEnabled
    if (typeof p.compact === 'boolean') compact.value = p.compact
  }

  /** 从当前全局 ref 构建 GlobalPrefs 对象（不含书级覆盖） */
  function buildCache(): GlobalPrefs {
    return {
      theme: theme.value,
      proseSize: proseSize.value,
      proseLh: proseLh.value,
      proseGap: proseGap.value,
      uiFontCn: uiFontCn.value,
      uiFontEn: uiFontEn.value,
      proseFontCn: proseFontCn.value,
      proseFontEn: proseFontEn.value,
      pageWidth: pageWidth.value,
      autosaveInterval: autosaveInterval.value,
      shelfView: shelfView.value,
      chatEnabled: chatEnabled.value,
      compact: compact.value,
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
    r.style.setProperty('--prose-gap', `${proseGap.value}em`)
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
  function setGap(v: number): void {
    proseGap.value = v
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

  return {
    theme,
    proseSize,
    proseLh,
    proseGap,
    uiFontCn,
    uiFontEn,
    proseFontCn,
    proseFontEn,
    pageWidth,
    autosaveInterval,
    shelfView,
    chatEnabled,
    compact,
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
    setGap,
    setUiFontCn,
    setUiFontEn,
    setProseFontCn,
    setProseFontEn,
    setPageWidth,
    setAutosaveInterval,
    setShelfView,
    setChatEnabled,
    setCompact,
  }
})
