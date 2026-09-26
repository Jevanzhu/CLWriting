import type { Ref } from 'vue'
import { buildFontFamily, buildProseFontStack } from './useSystemFonts'
import { createThemeApply } from '../shared/theme-apply'
import type { ThemeId } from '../types/theme'

/**
 * prefs 副作用面：写 DOM（主题 data-theme / CSS 变量 / 紧凑 class）
 * 与窗控变暗（WCO）从 prefs store 拆出——store 只持偏好数据与持久化，副作用经本工厂
 * 收 prefs refs 后执行（apply/applyCompact/applyTheme/setOverlayDimmed 四件本体纯移动，
 * 行为零变化；applyTheme/setOverlayDimmed 的窗控色族仍单源于 shared/theme-apply.ts）。
 *
 * 接线时序红线：prefs store 的 setup 内同步调用本工厂（= usePrefsStore 首次实例化），
 * init 在 main.ts mount 前 await——接线点早于首帧渲染，启动即写 CSS 变量与 data-theme，
 * 不晚于原时序（否则启动闪主题）。
 */
export interface PrefsDomEffectDeps {
  theme: Ref<ThemeId>
  proseSize: Ref<number>
  proseLh: Ref<number>
  /** 有效页宽（书级覆盖 > 全局）——computed 传入 */
  effectivePageWidth: Ref<number>
  uiFontSizeStep: Ref<number>
  uiFontCn: Ref<string>
  uiFontEn: Ref<string>
  proseFontCn: Ref<string>
  proseFontEn: Ref<string>
  compact: Ref<boolean>
}

export function createPrefsDomEffects(deps: PrefsDomEffectDeps) {
  // ── apply（直写 :root CSS 变量）──
  // 正文排版三件（字体/字号/行距）为全局正文偏好：设置「编辑器 → 排版」写 --prose-*，
  // 编辑区与开书对话/草稿卡等所有正文编辑框同步（作者确认全局一致，
  // 不设编辑器专属作用域）。
  function apply(): void {
    const r = document.documentElement
    r.style.setProperty('--prose-size', `${deps.proseSize.value}px`)
    r.style.setProperty('--prose-lh', String(deps.proseLh.value))
    r.style.setProperty('--page-width', `${deps.effectivePageWidth.value}px`)
    // →F0UI 字号档（外观「字号」设置，两平台通用）——win 隐藏基准
    // 原 +1px 系 ClearType hinting 补偿（灰度时代）找回原生子像素渲染后撤销归零，
    // 与 tokens 平台块同步；用户步进直接叠 0 基（内联值覆盖 CSS，此处始终写合计值）。
    // 恒零加数 baseStep 已删，写值与删前逐位一致。
    r.style.setProperty('--font-size-step', `${deps.uiFontSizeStep.value}px`)
    if (deps.uiFontCn.value || deps.uiFontEn.value) {
      r.style.setProperty(
        '--font-ui',
        buildFontFamily(deps.uiFontEn.value, deps.uiFontCn.value, 'system-ui, sans-serif'),
      )
    } else {
      r.style.removeProperty('--font-ui')
    }
    if (deps.proseFontCn.value || deps.proseFontEn.value) {
      // →F0c②：回退尾按中文字体族归边——衬线/书卷（宋·仿宋·楷·思源宋·
      // 文楷…）挂衬线基座带宋体，其余（雅黑/等线/黑体/思源黑…）挂无衬线基座——
      // 修「选思源黑体预设但未装 Noto 时正文静默落宋体」的跨族翻转；CN 槽空维持
      // 衬线基座（出厂空槽口径不变）。串值单源于 useSystemFonts 的 proseFallbackTail。
      r.style.setProperty('--prose-font', buildProseFontStack(deps.proseFontCn.value, deps.proseFontEn.value))
    } else {
      r.style.removeProperty('--prose-font')
    }
  }

  /** 紧凑模式：给 <html> 挂 .compact，全局 CSS 用该选择器收窄间距 */
  function applyCompact(): void {
    document.documentElement.classList.toggle('compact', deps.compact.value)
  }

  const { applyTheme, setOverlayDimmed } = createThemeApply(deps.theme)

  return { apply, applyCompact, applyTheme, setOverlayDimmed }
}
