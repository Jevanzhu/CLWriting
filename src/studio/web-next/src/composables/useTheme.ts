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

/** View Transitions API 类型（较新 API，TS lib 可能缺，局部声明避免 any）。*/
type VTDoc = Document & {
  startViewTransition?: (cb: () => void) => { ready: Promise<void> }
}

/** Awwwards 冲击面：主题切换圆形扩散。
 *  支持且未减弱动效时，新主题从点击点 clip-path 圆形扩散（400ms ease-std）；
 *  否则瞬切。event 缺省时圆心取视口中心。*/
function withThemeTransition(event: MouseEvent | undefined, fn: () => void): void {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const doc = document as VTDoc
  if (!doc.startViewTransition || reduceMotion) {
    fn()
    return
  }
  const x = event?.clientX ?? window.innerWidth / 2
  const y = event?.clientY ?? window.innerHeight / 2
  const endRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  )
  const t = doc.startViewTransition(() => fn())
  t.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
      {
        duration: 400,
        easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
        pseudoElement: '::view-transition-new(root)',
      },
    )
  })
}

/** 设置主题并持久化 + apply（可选圆形扩散过渡）。*/
function setTheme(id: ThemeId, event?: MouseEvent): void {
  theme.value = id
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* localStorage 不可用时仅内存切换 */
  }
  withThemeTransition(event, apply)
}

/** 切换亮/暗（可选圆形扩散过渡）。*/
function toggle(event?: MouseEvent): void {
  setTheme(theme.value === 'light' ? 'dark' : 'light', event)
}

export function useTheme() {
  // 返回模块级函数引用，解构后调用仍绑定正确（不依赖 this）
  return { theme, themes: THEMES, themeName, setTheme, toggle }
}

// 模块加载即应用持久化主题（main.ts 副作用 import 触发，确保渲染前 CSS 变量就位）
apply()
