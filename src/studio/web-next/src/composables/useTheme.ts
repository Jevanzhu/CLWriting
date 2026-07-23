// 主题切换：light / dark（M10 重写，取代旧 8 档色温）。
// 模块单例，持久化 localStorage（键 clw-theme）；模块加载即设 :root[data-theme]。
// 读到旧 8 档值（mono/paper/soft/moss/cool/linen/mist/haze）或空 → 回退 light。
import { ref } from 'vue'
import { THEMES, type ThemeId } from '../types/theme'

export type { ThemeId }
export { THEMES }

const KEY = 'clw-theme'

function read(): ThemeId {
  try {
    const v = localStorage.getItem(KEY)
    // 仅认 light/dark；旧 8 档色温值或空都回退 light（用户偏好迁移）
    return v === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

const theme = ref<ThemeId>(read())

/** 应用到 :root data-theme（tokens.css 按 [data-theme] 切换语义变量）。*/
function apply(): void {
  document.documentElement.dataset.theme = theme.value
}

/** 当前主题显示名。*/
function themeName(): string {
  return THEMES.find((t) => t.id === theme.value)?.name ?? '亮色'
}

/** 设置主题并持久化 + apply。*/
function setTheme(id: ThemeId): void {
  theme.value = id
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* localStorage 不可用时仅内存切换 */
  }
  apply()
}

/** 切换亮/暗。*/
function toggle(): void {
  setTheme(theme.value === 'light' ? 'dark' : 'light')
}

export function useTheme() {
  // 返回模块级函数引用，解构后调用仍绑定正确（不依赖 this）
  return { theme, themes: THEMES, themeName, setTheme, toggle }
}

// 模块加载即应用持久化主题（main.ts 副作用 import 触发，确保渲染前 CSS 变量就位）
apply()
