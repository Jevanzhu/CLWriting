import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getGlobalPrefs, putGlobalPrefs, type GlobalPrefs } from '../api/prefs'
import type { ThemeId } from '../types/theme'

/**
 * 全局编辑器偏好 store（主题 + 排版 + 字体）。
 *
 * 存储：.clwriting/global.json（JSON 文件，对齐 Obsidian vault 级配置）。
 * 替代旧 localStorage（LevelDB 黑盒，不可编辑不可备份）。
 *
 * 初始化：main.ts 在 mount 前 await init() → API 读取 → apply CSS 变量。
 * 首次为空时从旧 localStorage 自动迁移。
 * 持久化：setter 改值后 debounce 500ms 写回 API。
 */
const DEFAULTS = {
  theme: 'light' as ThemeId,
  proseSize: 17,
  proseLh: 1.85,
  proseGap: 1,
  pageWidth: 1020,
  autosaveInterval: 30,
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

  // 持久化缓存 + debounce 定时器
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  /** 异步初始化：从 .clwriting/global.json 加载（替代 localStorage）。
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
  }

  /** 从当前 ref 构建 GlobalPrefs 对象 */
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
    }
  }

  /** debounce 写回 .clwriting/global.json（500ms） */
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
    r.style.setProperty('--page-width', `${pageWidth.value}px`)
    // 字体：仅用户设定时覆盖，否则用 tokens.css 默认（完整 fallback 链）
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

  // ── setter（设值 + apply + debounce 持久化）──

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
  function setPageWidth(v: number): void {
    pageWidth.value = v
    apply()
    schedulePersist()
  }
  function setAutosaveInterval(v: number): void {
    autosaveInterval.value = v
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
    init,
    apply,
    applyTheme,
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
  }
})
