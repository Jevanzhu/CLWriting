// 主题切换：mono 标准 / paper 暖纸 / soft 柔光。
// 模块单例，持久化 localStorage，模块加载即设 :root[data-theme] 切换全套色 token。
// 2026-07-02 整合原 useReaderTheme：阅读配色不再独立，三档色温作为主题。
import { ref } from 'vue'
import { THEMES, type ThemeId, type ThemeDef } from '../types/theme'

export type { ThemeId, ThemeDef }
export { THEMES }

const KEY = 'clw-theme'

function read(): ThemeId {
  try {
    const v = localStorage.getItem(KEY)
    return THEMES.some((t) => t.id === v) ? (v as ThemeId) : 'mono'
  } catch {
    return 'mono'
  }
}

const theme = ref<ThemeId>(read())

/** 应用到 :root data-theme 属性（tokens.css 按 [data-theme] 切换全套色 token） */
function apply(): void {
  document.documentElement.dataset.theme = theme.value
}

/** 兼容旧 API：返回当前主题名 */
function themeName(): string {
  return THEMES.find((t) => t.id === theme.value)?.name ?? 'mono'
}

export function useTheme() {
  return {
    theme,
    themes: THEMES,
    themeName,
    setTheme(id: ThemeId): void {
      theme.value = id
      try {
        localStorage.setItem(KEY, id)
      } catch {
        /* localStorage 不可用时仅内存切换 */
      }
      apply()
    },
  }
}

// 模块加载即应用持久化主题（main.ts 显式 import 触发，确保渲染前 CSS var 就位）
apply()
