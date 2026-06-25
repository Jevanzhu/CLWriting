/** 应用全局态（对照 v5 state 视图域；view/mode 由路由决定，不入 store） */
import { defineStore } from 'pinia'
import { THEMES, type ThemeId } from '../types'

interface AppState {
  /** 主题（7 套，对照 v5 THEMES） */
  theme: ThemeId
  /** 专注模式（⌘⇧F） */
  focus: boolean
  /** 左栏折叠（⌘B） */
  foldL: boolean
  /** 当前书库 id（多书库预留，当前单 workDir） */
  currentLibId: string
  /** 设置弹层开 */
  cfgOpen: boolean
}

export const useAppStore = defineStore('app', {
  state: (): AppState => ({
    theme: loadTheme(),
    focus: false,
    foldL: false,
    currentLibId: '',
    cfgOpen: false,
  }),
  getters: {
    themeDef: (s) => THEMES.find((t) => t.id === s.theme) ?? THEMES[0]!,
    themeName: (s) => THEMES.find((t) => t.id === s.theme)?.name ?? '',
  },
  actions: {
    setTheme(id: ThemeId) {
      this.theme = id
      localStorage.setItem('clw-theme', id)
      this.applyTheme()
    },
    cycleTheme() {
      const i = THEMES.findIndex((t) => t.id === this.theme)
      this.setTheme(THEMES[(i + 1) % THEMES.length]!.id)
    },
    /** 同步 data-theme 到 <html> */
    applyTheme() {
      document.documentElement.dataset.theme = this.theme
    },
    toggleFocus() {
      this.focus = !this.focus
    },
    toggleFoldL() {
      this.foldL = !this.foldL
    },
  },
})

function loadTheme(): ThemeId {
  const s = localStorage.getItem('clw-theme') as ThemeId | null
  return s && THEMES.some((t) => t.id === s) ? s : 'ink'
}
