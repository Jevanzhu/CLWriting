// 主题切换：light / dark（M10 重写，取代旧 8 档色温）。
// 主题数据由 prefs store 管理（.clwriting/global.json 持久化），useTheme 仅负责
// DOM 动效（圆形扩散过渡）+ 对外接口。
// init 由 prefs.init() 在 main.ts mount 前触发（applyTheme 设 :root[data-theme]）。
import { computed } from 'vue'
import { usePrefsStore } from '../stores/prefs'
import { THEMES, type ThemeId } from '../types/theme'

export type { ThemeId }
export { THEMES }

/** View Transitions API 类型（较新 API，TS lib 可能缺，局部声明避免 any）。*/
type VTDoc = Document & {
  startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> }
}

/** Awwwards 冲击面：主题切换圆形扩散时长（ms）——与下方 animate duration 同源。 */
const SWEEP_MS = 400

/** Awwwards 冲击面：主题切换圆形扩散。
 *  支持且未减弱动效时，新主题从点击点 clip-path 圆形扩散（400ms ease-std）；
 *  否则瞬切。event 缺省时圆心取视口中心。
 *  win 桌面不走特效（2026-09-04 作者拍板）：WCO 窗控条是 DWM 实色带、进不了
 *  网页合成器，扩散期间窗控色只能按「前沿到达时刻」编排单拍切，帧级错位两轮
 *  实测被打回（先闪烁/延迟、修准反解后仍滞后）——win 放弃特效整体瞬切，窗控
 *  色经 applyTheme→syncOverlayNow 与页面同一刻落定即「一起变」。mac（hiddenInset
 *  交通灯透明底浮在网页上，底下像素随特效逐帧自然变）与纯浏览器保留特效。 */
function withThemeTransition(event: MouseEvent | undefined, fn: () => void): void {
  if (window.clwritingDesktop?.platform === 'win32') {
    fn()
    return
  }
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
  // R43-9（四十三轮）：ready/finished 补防御 catch——ViewTransition 被抢占（过渡中再切
  // 主题/skipTransition 等）时两 promise 按 API 约定 reject：ready 的浮空 .then 成为
  // unhandledRejection。窗控色同步已随 win 瞬切收口（applyTheme 无条件 syncOverlayNow，
  // 原 overlaySweep 挂起机制删除），此处只剩特效自身的异常面。
  t.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
        {
          duration: SWEEP_MS,
          easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      )
    })
    .catch(() => {})
  t.finished.catch(() => {})
}

export function useTheme() {
  const prefs = usePrefsStore()
  const theme = computed<ThemeId>(() => prefs.theme)

  /** 当前主题显示名。*/
  function themeName(): string {
    return THEMES.find((t) => t.id === theme.value)?.name ?? '亮色'
  }

  /** 设置主题并持久化 + apply（可选圆形扩散过渡）。*/
  function setTheme(id: ThemeId, event?: MouseEvent): void {
    withThemeTransition(event, () => prefs.setThemeValue(id))
  }

  /** 切换亮/暗（可选圆形扩散过渡）。*/
  function toggle(event?: MouseEvent): void {
    setTheme(theme.value === 'light' ? 'dark' : 'light', event)
  }

  return { theme, themes: THEMES, themeName, setTheme, toggle }
}
