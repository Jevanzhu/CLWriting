/**
 * 主题应用纯逻辑族 —— 自 src/studio/web-next/src/stores/prefs.ts theme-apply 缝拆出。
 *
 * R0916-5i（2026-09-16，⑤④产品巨件拆分波5）：prefs.ts（871 行）theme-apply 缝纯移动
 * 拆分。本文件承载：applyTheme 本体（data-theme 落定 + win theme-instant 过渡压制 +
 * 双 rAF 窗控色跟随）、theme-instant 压制代数（R48-86 useStaleGuard 实例）、窗控
 * overlay 色族（overlayAlpha/overlayColorsFor/applyOverlayAlpha/syncOverlayNow/
 * setOverlayDimmed，win 基础色 0xF6/0x26 与遮罩等效色代数随注释单源在此）。
 * 纯移动声明：注释与代码逐字随迁、零行为变化、零逻辑改写；唯一差异 = 缝入本文件
 * 所需的最小必要签名改动（store 闭包 → 工厂闭包参数化，逐处记档见下）：
 * - createThemeApply(theme: Ref<ThemeId>) 工厂收 theme ref——族内 theme.value 读点
 *   逐字不变（rAF 回调按回调执行时刻活读当前主题，R48-86 快速连切「旧回调按最新
 *   主题重发窗控色」口径保持；传值参数会冻结读点，是行为改写，不取）。
 * - overlayAlpha / themeInstantGen 为 per-store 实例态，随族迁入工厂闭包保持
 *   per-instance 语义（上提模块顶层会跨 store 实例串态——测试内连续 createPinia
 *   即泄漏；单源求值侧在本文件工厂内，不经环回链，TDZ 无涉）。
 * prefs store 残核（状态 refs/DEFAULTS/localStorage 持久化迁移/setter 表驱动/
 * store 门口径）零触碰，经 createThemeApply(theme) 解构 applyTheme/setOverlayDimmed
 * 桥接，init/finishRow/store 出口调用点原位零改动；overlay-dim.test.ts 对
 * prefs.ts 的 theme-instant 源码锁由残核缝指针注记承接（见 prefs.ts 缝位注记）。
 * 依赖单向无环：本文件 import composables/useStaleGuard + types/theme（type）+
 * vue（type），不回引 stores/*；模块顶层零求值常量（状态全在工厂闭包内）。
 */
import { useStaleGuard } from '../composables/useStaleGuard'
import type { Ref } from 'vue'
import type { ThemeId } from '../types/theme'

/**
 * 主题应用族工厂：theme 以 ref 传入（族内 theme.value 读点原样随迁），返回
 * applyTheme/setOverlayDimmed 供 prefs store 桥接（原 store 内同名函数，
 * 全部调用点零改动）。
 */
export function createThemeApply(theme: Ref<ThemeId>) {
  // ── 窗控 overlay 色（win）──
  // WCO 能力上限 = 实色 + 主题跟随（'transparent' 不被 Chromium 接受、按钮底色也不跟
  // nativeTheme，2026-08-31 实测）。基础色 = 两档 --background-secondary（= 顶栏底，
  // light 0xF6 / dark 0x26，灰通道三值同）。遮罩压暗期间的色 = 顶栏底被遮罩吸收后的
  // 等效色：round(bg × (1-α))，α = 当前有效遮罩浓度——各弹窗遮罩浓度不同（设置 .45、
  // 书架/导出/确认 .35、命令面板 .25，名单在 ui store MASK_ALPHA 与组件 CSS 镜像、
  // overlay-dim.test.ts 锁死；多层叠开按 1-Π(1-α) 复合）。此前只有 .45 一档标定值
  // （light #878787 / dark #151515），书架等 .35 遮罩下窗控深一档即「颜色不统一」。
  /** 当前有效遮罩浓度（0 = 无遮罩，窗控还原基础色）。 */
  let overlayAlpha = 0

  function overlayColorsFor(alpha: number): { color: string; symbolColor: string; dark: boolean } {
    const dark = theme.value === 'dark'
    const bg = dark ? 0x26 : 0xf6
    const ch = Math.round(bg * (1 - alpha)).toString(16).padStart(2, '0')
    return { color: `#${ch}${ch}${ch}`, symbolColor: dark ? '#c8c8c8' : '#666666', dark }
  }
  /** 下发窗控色。非 win32 短路（测试/浏览器态）。 */
  function applyOverlayAlpha(alpha: number): void {
    const d = typeof window === 'undefined' ? undefined : window.clwritingDesktop
    if (d?.platform !== 'win32') return
    void d.setTitleBarOverlay(overlayColorsFor(alpha))
  }
  /** 瞬切到当前应有色（遮罩开关 / 主题落定）。为什么不做过渡：WCO 色是 DWM
   *  窗口属性（实色、无 alpha），不在网页合成器里——CSS/View Transition 的
   *  时间线管不到它，「跟随渐变」只能逐帧 IPC 改属性拼（2026-09-04 试过 8 帧 ×
   *  25ms：帧距被 IPC/主进程时延拉散即闪烁，整体拖过遮罩自身淡入即延迟，作者
   *  实测打回）。mac hiddenInset 交通灯没有这个问题：按钮是透明底浮在网页上方，
   *  底下像素随遮罩/主题特效逐帧自然变，无需联动——win 的等价能力只有放弃原生
   *  窗控自绘 HTML 一条路，此处维持原生 + 单拍瞬切；主题切换同理（win 不做
   *  扩散特效，见 useTheme.withThemeTransition，applyTheme 与页面同拍落定）。 */
  function syncOverlayNow(): void {
    if (typeof window === 'undefined') return
    applyOverlayAlpha(overlayAlpha)
  }

  /**
   * 弹窗遮罩联动窗控色（win）：全屏遮罩压暗页面时，系统绘制的窗控条不会被压暗——
   * 暗页面顶着一列亮块即作者反馈的「窗控突兀」。alpha = 有效遮罩浓度（0 = 还原）。
   * 与遮罩起始同刻单拍落终值（不做逐帧过渡，缘由见 syncOverlayNow）。
   */
  function setOverlayDimmed(open: boolean, alpha = 0): void {
    overlayAlpha = open ? alpha : 0
    syncOverlayNow()
  }

  /** R48-86（四十八轮）：theme-instant 压制代数——applyTheme 每次自增，rAF 回调据
   *  此判最新性（快速连切防旧回调提前摘新回调的压制 class，详见 applyTheme 注）。
   *  E6（复审-0914-优化修复批）：裸计数器换装 useStaleGuard。 */
  const themeInstantGen = useStaleGuard()

  function applyTheme(): void {
    document.documentElement.dataset.theme = theme.value
    // 窗控色与主题同一（同步）拍落定即「一起变」——win 已不做扩散特效
    //（useTheme.withThemeTransition 瞬切），原「特效期间挂起、前沿到达再切」的
    // overlaySweep 编排随 2026-09-04 拍板删除（其唯一有效平台就是 win）。
    // win 翻转拍压制全局过渡：按钮/链接基线 hover transition（--dur-fast）会在
    // 主题翻转时让全页面颜色渐变 120ms+，与瞬切的窗控条错位（作者反馈「切换
    // 配色不同步」）；翻转帧绘制完成后摘除，日常 hover 过渡不受影响。mac/浏览器
    // 走 VT 新旧快照翻转（base.css ::view-transition-*），页面本就单帧换血。
    const d = typeof window === 'undefined' ? undefined : window.clwritingDesktop
    if (d?.platform === 'win32') {
      const rootEl = document.documentElement
      rootEl.classList.add('theme-instant')
      // R48-86（四十八轮）：快速连切时两次 applyTheme 叠加——第一次的 rAF 回调会把第二
      // 次刚挂上的 theme-instant 提前摘掉（第二拍 restyle 退回渐变、与窗控错位）。回调
      // 带序号守卫：非最新代不摘 class（摘除权归最新回调），只 syncOverlayNow 让窗控
      // 色即时跟随当前主题（幂等重发无害）
      const gen = themeInstantGen.begin()
      // 窗控色延到页面新色扫描输出之后再落（双 rAF = 下一帧帧首，翻转帧已
      // present）：144Hz 帧预算 6.9ms，整页 restyle 必超预算——pre-flush 发送会让
      // 窗控恒定领先页面 1-2 帧（角落先变 = 「抢跑」，作者反馈「切换配色不同
      // 步」）。改为页面先变、窗控随即跟上（落后 ≤1 帧），跟随方向与直觉一致。
      // 遮罩路径（setOverlayDimmed）不照抄：遮罩帧已轻量化到单帧预算内
      // （ShelfModal/SettingsModal contentReady 分帧），pre-flush 发送即与遮罩
      // 同帧扫描输出，才是真同步。
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (themeInstantGen.stale(gen)) {
            syncOverlayNow()
            return
          }
          rootEl.classList.remove('theme-instant')
          syncOverlayNow()
        }),
      )
      return
    }
    syncOverlayNow()
  }

  return { applyTheme, setOverlayDimmed }
}
