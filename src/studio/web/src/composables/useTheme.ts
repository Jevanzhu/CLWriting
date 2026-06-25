import { ref, watch } from 'vue'

// 主题系统：4 套配色，data-theme 挂 <html>，localStorage 持久化。
// 详见 Dev/Plans/桌面端与界面计划.md 第四节「配色」。

export type ThemeId = 'ink' | 'night' | 'plain' | 'slate'

export interface ThemeMeta {
  id: ThemeId
  name: string
  desc: string
}

export const THEMES: ThemeMeta[] = [
  { id: 'ink', name: '墨韵', desc: '宣纸暖·中式中浅' },
  { id: 'night', name: '墨夜', desc: '宣纸暖·深色' },
  { id: 'plain', name: '素简', desc: '米白冷·企业风' },
  { id: 'slate', name: '青砚', desc: '灰青冷·专业' },
]

const STORAGE_KEY = 'clw-theme'
const ORDER: ThemeId[] = ['ink', 'night', 'plain', 'slate']

function load(): ThemeId {
  const saved = localStorage.getItem(STORAGE_KEY) as ThemeId | null
  return saved && ORDER.includes(saved) ? saved : 'ink'
}

function apply(id: ThemeId): void {
  document.documentElement.dataset.theme = id
}

// 单例主题状态（模块级，全 app 共享）
const theme = ref<ThemeId>(load())
apply(theme.value)

watch(theme, (id) => {
  apply(id)
  localStorage.setItem(STORAGE_KEY, id)
})

export function useTheme() {
  return {
    theme,
    themes: THEMES,
    setTheme: (id: ThemeId): void => {
      theme.value = id
    },
    cycleTheme: (): void => {
      const i = ORDER.indexOf(theme.value)
      theme.value = ORDER[(i + 1) % ORDER.length]
    },
    themeName: (): string => THEMES.find((t) => t.id === theme.value)?.name ?? '',
  }
}
