// @vitest-environment happy-dom
/**
 * J5 窗控压暗联动（2026-09-04 二次修复）：
 *  1. 遮罩浓度表与组件 CSS 镜像锁死——各弹窗遮罩浓度不同（设置 .45 / 书架·导出·
 *     确认 .35 / 命令面板 .25 / 书架子弹窗 .5·.3），窗控色按有效浓度合成，写死一档
 *     即「颜色不统一」（原 .45 标定值在书架 .35 遮罩下深一档）。改遮罩透明度须
 *     CSS 与 MASK_ALPHA 两处同步，本测试逐文件锁死。
 *  2. 压暗色合成 = round(顶栏底 × (1-α))，light 0xF6 / dark 0x26（--background-secondary）。
 *  3. 多层叠开按 1-Π(1-α) 复合（书架叠确认框 / 书架叠删除确认子弹窗）。
 *  4. 遮罩开/关单拍瞬切到终值——WCO 色是 DWM 窗口属性不进网页合成器，逐帧 IPC 拼
 *     过渡帧距不匀即闪烁、拖过遮罩淡入即延迟（2026-09-04 作者实测打回，试过 8 帧×25ms）。
 *  5. win 主题切换瞬切（不做 mac 式圆形扩散，2026-09-04 作者拍板）：不走
 *     ViewTransition，窗控色与页面主题同一拍落定即「一起变」。
 *  6. win 弹窗遮罩不渐变（animation:none 名单锁）：窗控条是 DWM 实色只能瞬切，
 *     遮罩 200ms 渐变期内两者色阶必然错位（实测全链路 IPC+主进程 2ms、首绘 9ms，
 *     错位全在渐变期）；瞬切后同为单帧跳变。mac 保留渐变。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useUiStore, MASK_ALPHA, SHELF_DEEP_ALPHA } from '../../../src/studio/web-next/src/stores/ui'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'
import { useTheme } from '../../../src/studio/web-next/src/composables/useTheme'

const ROOT = resolve(__dirname, '../../../src/studio/web-next/src/components/ui')

/** 从组件源码中提取指定 class 块内的 rgba(0,0,0,α) 遮罩浓度 */
function maskAlphaIn(file: string, cls: string): number {
  const text = readFileSync(resolve(ROOT, file), 'utf-8')
  const m = text.match(new RegExp(`\\.${cls}\\s*\\{[^}]*rgba\\(0,\\s*0,\\s*0,\\s*(0\\.\\d+)\\)`))
  if (!m) throw new Error(`${file} 中未找到 .${cls} 的 rgba(0,0,0,α) 遮罩定义`)
  return Number(m[1])
}

describe('J5-1: 遮罩浓度表与组件 CSS 镜像（防漂移锁）', () => {
  it('各全屏遮罩透明度 = MASK_ALPHA / SHELF_DEEP_ALPHA', () => {
    expect(maskAlphaIn('settings-shared.css', 'modal-mask')).toBe(MASK_ALPHA.settings)
    expect(maskAlphaIn('ShelfModal.vue', 'shelf-mask')).toBe(MASK_ALPHA.shelf)
    expect(maskAlphaIn('ExportDialog.vue', 'modal-mask')).toBe(MASK_ALPHA.export)
    expect(maskAlphaIn('CommandPalette.vue', 'palette-mask')).toBe(MASK_ALPHA.palette)
    expect(maskAlphaIn('ConfirmPrompt.vue', 'cp-mask')).toBe(MASK_ALPHA.confirm)
    expect(maskAlphaIn('ConfirmDeleteModal.vue', 'confirm-overlay')).toBe(SHELF_DEEP_ALPHA.confirmDelete)
    expect(maskAlphaIn('CreateBookModal.vue', 'create-overlay')).toBe(SHELF_DEEP_ALPHA.create)
  })
})

describe('J5-2/3/4: 压暗色按有效浓度合成 + 叠层复合 + 单拍瞬切', () => {
  let overlay: ReturnType<typeof vi.fn>
  const lastCall = () => overlay.mock.calls.at(-1)?.[0] as { color: string }

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    overlay = vi.fn()
    ;(window as unknown as Record<string, unknown>).clwritingDesktop = {
      platform: 'win32',
      setTitleBarOverlay: overlay,
    }
  })
  afterEach(() => {
    vi.useRealTimers()
    ;(window as unknown as Record<string, unknown>).clwritingDesktop = undefined
  })

  it('单层 .45（设置）= 旧标定值向后兼容：light #878787 / dark #151515', async () => {
    const prefs = usePrefsStore()
    prefs.setOverlayDimmed(true, MASK_ALPHA.settings)
    await vi.advanceTimersByTimeAsync(220)
    expect(lastCall().color).toBe('#878787')
    prefs.setThemeValue('dark') // 主题落定瞬切（非遮罩路径；win 走双 rAF 延发，见 applyTheme）
    await vi.advanceTimersByTimeAsync(80) // 冲排两帧：翻转帧绘制完成后窗控才落
    expect(lastCall().color).toBe('#151515')
  })

  it('单层 .35（书架）：light #a0a0a0（原 #878787 深一档即错）', async () => {
    const prefs = usePrefsStore()
    prefs.setOverlayDimmed(true, MASK_ALPHA.shelf)
    await vi.advanceTimersByTimeAsync(220)
    expect(lastCall().color).toBe('#a0a0a0')
  })

  it('遮罩开→关各单拍瞬切（无逐帧拼过渡→无闪烁源）且关净还原基础色', async () => {
    const prefs = usePrefsStore()
    prefs.setOverlayDimmed(true, 0.35)
    expect(overlay).toHaveBeenCalledTimes(1) // 开：一次 IPC 落终值
    expect(lastCall().color).toBe('#a0a0a0')
    overlay.mockClear()
    prefs.setOverlayDimmed(false)
    expect(overlay).toHaveBeenCalledTimes(1) // 关：同刻一次还原
    expect(lastCall().color).toBe('#f6f6f6')
    await vi.advanceTimersByTimeAsync(220) // 不存在续拍定时器
    expect(overlay).toHaveBeenCalledTimes(1)
  })

  it('书架叠确认框（.35+.35 复合 .5775）→ light #686868；关上层回书架档', async () => {
    const ui = useUiStore()
    ui.openShelf()
    await nextTick()
    await vi.advanceTimersByTimeAsync(220)
    expect(lastCall().color).toBe('#a0a0a0')
    // ask 返回的 Promise 在 resolveConfirm 前不结算——持引用后置 await，防测试死锁
    const askP = ui.ask({ title: '删', message: '确认？' })
    await nextTick()
    await vi.advanceTimersByTimeAsync(220)
    expect(lastCall().color).toBe('#686868') // 246 × (1-.5775) = 104
    ui.resolveConfirm(false)
    await askP
    await nextTick()
    await vi.advanceTimersByTimeAsync(220)
    expect(lastCall().color).toBe('#a0a0a0')
  })

  it('书架叠删除确认子弹窗（.35+.5 复合 .675）→ light #505050；书架关闭时子弹窗残留值不生效', async () => {
    const ui = useUiStore()
    ui.openShelf()
    await nextTick()
    ui.setShelfDeepAlpha(SHELF_DEEP_ALPHA.confirmDelete)
    await nextTick()
    await vi.advanceTimersByTimeAsync(220)
    expect(lastCall().color).toBe('#505050') // 246 × (1-.675) = 80
    ui.closeShelf()
    await nextTick()
    await vi.advanceTimersByTimeAsync(220)
    expect(lastCall().color).toBe('#f6f6f6') // 残留 deep 被 shelfOpen 折叠
  })

  it('暗色主题下单层书架 → dark #191919', async () => {
    const prefs = usePrefsStore()
    prefs.setThemeValue('dark')
    const ui = useUiStore()
    ui.openShelf()
    await nextTick()
    await vi.advanceTimersByTimeAsync(220)
    expect(lastCall().color).toBe('#191919') // 38 × 0.65 = 25
  })
})

describe('J5-6: win 遮罩瞬切（base.css 覆盖名单与全屏遮罩类对齐）', () => {
  it('win32 animation:none 名单覆盖全部全屏遮罩类（新增遮罩须入名单）', () => {
    const css = readFileSync(
      resolve(__dirname, '../../../src/studio/web-next/src/styles/base.css'),
      'utf-8',
    )
    const m = css.match(/:root\[data-platform='win32'\]([^{}]+)\{[^}]*animation:\s*none/)
    expect(m).toBeTruthy()
    const list = m![1]
    for (const cls of [
      '.modal-mask',
      '.shelf-mask',
      '.palette-mask',
      '.cp-mask',
      '.picker-mask',
      '.confirm-overlay',
      '.create-overlay',
    ]) {
      expect(list).toContain(cls)
    }
  })
  it('theme-instant 全局过渡压制在位（win 翻转拍页面单帧换血与窗控同拍）', () => {
    const css = readFileSync(
      resolve(__dirname, '../../../src/studio/web-next/src/styles/base.css'),
      'utf-8',
    )
    // prefs.applyTheme 挂/摘 .theme-instant 依赖这条 CSS 存在——改名须两处同步
    expect(css).toMatch(/html\.theme-instant[^{}]*\{[^}]*transition:\s*none\s*!important/)
    const prefsSrc = readFileSync(
      resolve(__dirname, '../../../src/studio/web-next/src/stores/prefs.ts'),
      'utf-8',
    )
    expect(prefsSrc).toContain("classList.add('theme-instant')")
    expect(prefsSrc).toContain("classList.remove('theme-instant')")
  })
  it('书架/设置弹层分帧延挂（afterPaint 真分帧，遮罩轻帧与窗控同帧扫描输出）', () => {
    // 144Hz 帧预算 6.9ms：重内容与遮罩同帧挂载必超预算、落后窗控 1-2 帧。
    // 分帧原语必须是 afterPaint（单 rAF 的微任务仍在同帧渲染管线内，等于没分）
    const util = readFileSync(
      resolve(__dirname, '../../../src/studio/web-next/src/shared/after-paint.ts'),
      'utf-8',
    )
    expect(util).toContain('requestAnimationFrame')
    expect(util).toContain('setTimeout')
    for (const f of ['SettingsModal.vue', 'ShelfModal.vue']) {
      const src = readFileSync(
        resolve(__dirname, '../../../src/studio/web-next/src/components/ui', f),
        'utf-8',
      )
      expect(src).toContain('afterPaint')
      expect(src).toMatch(/v-if="contentReady"/)
    }
  })
  it('独立整页拖拽区 win 实色底带与窗控基础色贴合（书库/首启/书架窗）', () => {
    // 窗控条 = --background-secondary 实色，条底透明透 primary 渐变则两档 token
    // 恒差一级（作者反馈「书库管理窗控颜色不同步」）。新增独立整页须入名单。
    const css = readFileSync(
      resolve(__dirname, '../../../src/studio/web-next/src/styles/base.css'),
      'utf-8',
    )
    const m = css.match(
      /:root\[data-platform='win32'\]([^{}]+)\{[^}]*background:\s*var\(--background-secondary\)/,
    )
    expect(m).toBeTruthy()
    for (const cls of ['.lib-titlebar', '.welcome-titlebar', '.shelf-titlebar']) {
      expect(m![1]).toContain(cls)
    }
  })
})

describe('J5-5: win 主题切换瞬切（不做扩散特效；页面先变、窗控跟随落定）', () => {
  it('win 平台 toggle 不走 ViewTransition，窗控色在翻转帧绘制完成后落下', async () => {
    // happy-dom 缺 matchMedia 时补最小替身（只读 .matches）
    if (typeof window.matchMedia !== 'function') {
      ;(window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia =
        () => ({ matches: false })
    }
    setActivePinia(createPinia())
    const overlay = vi.fn()
    const vtSpy = vi.fn(() => ({ ready: Promise.resolve(), finished: Promise.resolve() }))
    const docEl = document.documentElement as unknown as Record<string, unknown>
    const vtDoc = document as unknown as Record<string, unknown>
    const prevAnimate = docEl.animate
    ;(window as unknown as Record<string, unknown>).clwritingDesktop = {
      platform: 'win32',
      setTitleBarOverlay: overlay,
    }
    docEl.animate = vi.fn() // happy-dom 无 Element.animate
    vtDoc.startViewTransition = vtSpy
    try {
      const { toggle } = useTheme()
      overlay.mockClear()
      toggle()
      expect(vtSpy).not.toHaveBeenCalled() // 无特效：win 不进 ViewTransition
      expect(docEl.animate).not.toHaveBeenCalled()
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(document.documentElement.classList.contains('theme-instant')).toBe(true) // 翻转拍过渡压制在挂
      // 窗控色延到翻转帧扫描输出之后（双 rAF，144Hz 下页面先变、窗控跟随 ≤1 帧，
      // 见 prefs.applyTheme 注释）——冲排两帧后断言落定
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      )
      await new Promise<void>((r) => setTimeout(r, 0))
      expect(document.documentElement.classList.contains('theme-instant')).toBe(false) // 翻转帧已绘制完，过渡恢复
      expect(overlay).toHaveBeenCalledTimes(1)
      const last = overlay.mock.calls.at(-1)?.[0] as { color: string }
      expect(last.color).toBe('#262626') // dark 基础色
    } finally {
      vtDoc.startViewTransition = undefined
      ;(window as unknown as Record<string, unknown>).clwritingDesktop = undefined
      if (prevAnimate === undefined) docEl.animate = undefined
      else docEl.animate = prevAnimate
    }
  })
})
