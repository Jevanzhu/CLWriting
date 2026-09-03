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

/** 圆形扩散前沿到达 WCO 窗控区（右上角 137×31 系统条）的时刻（ms）。
 *  系统窗控无法参与渐变（瞬切），若在特效开始就切色会先于整体 400ms 渐变——
 *  作者反馈「不同步」。解法：按扩散前沿扫到窗控区的时刻延迟切色，视觉上窗控
 *  恰在光圈波及它时跟随变化。缓动 cubic-bezier(.4,0,.2,1) 的纵曲线为 3t²-2t³
 *  （控制点 y1=0,y2=1），反解时间占比 t 即得延迟。 */
function sweepArrivalMs(x: number, y: number, endRadius: number): number {
  const left = window.innerWidth - 137
  const dx = Math.max(left - x, 0, x - window.innerWidth)
  const dy = Math.max(-y, 0, y - 31)
  const d = Math.hypot(dx, dy)
  const p = Math.min(1, d / endRadius)
  if (p <= 0) return 0
  let t = 0.5
  for (let i = 0; i < 12; i++) {
    const f = 3 * t * t - 2 * t * t * t - p
    const df = 6 * t - 6 * t * t
    t = Math.min(1, Math.max(0, t - f / (df || 1e-6)))
  }
  return Math.round(t * SWEEP_MS)
}

/** Awwwards 冲击面：主题切换圆形扩散。
 *  支持且未减弱动效时，新主题从点击点 clip-path 圆形扩散（400ms ease-std）；
 *  否则瞬切。event 缺省时圆心取视口中心。窗控色由 prefs 延迟到扩散扫过时刻。*/
function withThemeTransition(event: MouseEvent | undefined, fn: () => void): void {
  const prefs = usePrefsStore()
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
  prefs.beginOverlaySweep()
  const t = doc.startViewTransition(() => fn())
  // R43-9（四十三轮）：ready/finished 补防御 catch——ViewTransition 被抢占（过渡中再切
  // 主题/skipTransition 等）时两 promise 按 API 约定 reject：ready 的浮空 .then 成为
  // unhandledRejection；finished 不 settle 到 finally 则 endOverlaySweep 不执行，
  // overlaySweep 滞留 true 压制 applyTheme 的窗控色同步（窗控色从此不跟主题）。
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
      prefs.syncOverlayDelayed(sweepArrivalMs(x, y, endRadius))
    })
    .catch(() => {})
  t.finished
    .catch(() => {})
    .finally(() => prefs.endOverlaySweep())
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
