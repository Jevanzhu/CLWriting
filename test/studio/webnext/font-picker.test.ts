// @vitest-environment happy-dom
/**
 * R39-3/R39-4（三十九轮）：win 自绘 FontPicker 交互回归。
 *
 * - R39-3：浮层自身滚动不关闭——原 `window.addEventListener('scroll', …, true)` 捕获
 *   监听把 target=菜单的 scroll 也当锚位失效，列表溢出（win 字体族 100+，maxHeight
 *   ≤360px 约容 12 项）后首个滚动 tick 即关闭，第 13 项及以后的字体永远选不到；修后
 *   仅浮层外的滚动/窗口 resize 关闭。
 * - R39-4：open 态捕获消费 Esc（preventDefault + stopPropagation）——组件注册晚于
 *   useHotkeys（专注排版条挂载后才挂），bubble 派发按注册序 useHotkeys 先跑、
 *   defaultPrevented 检查救不了；capture 注册先于全部 bubble 监听（与注册序无关），
 *   对齐 ContextMenu/SettingsModal/ExportDialog 的 Z-23「本层消费防同键退专注」口径。
 * - 2026-09-04（作者反馈两项）：
 *   ① 下拉延迟——浮层改首开后常驻（v-show 复开），closed 契约从「元素摘除」改为
 *     「display:none 隐藏」，断言按可见性；复开须复用同一 DOM 节点（零重建）。
 *   ② 默认态直显默认字体名——defaultFont prop：按钮 label/title 用 display(defaultFont)，
 *     菜单首项（重置回默认）显「默认 · 名」；无 defaultFont 回落 placeholder。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('../../../src/studio/web-next/src/composables/usePlatform', () => ({
  usePlatform: () => ({ isWin: true, isMac: false }),
}))

import FontPicker from '../../../src/studio/web-next/src/components/ui/FontPicker.vue'
import { useSystemFonts, PROSE_FONT_FALLBACK } from '../../../src/studio/web-next/src/composables/useSystemFonts'

const PROPS = {
  value: '',
  fonts: Array.from({ length: 30 }, (_, i) => `Font${i}`),
  placeholder: '默认字体',
  display: (f: string): string => f,
}

let wrapper: ReturnType<typeof mount> | null = null

function menuEl(): HTMLElement {
  const el = document.body.querySelector('.fp-menu')
  if (!el) throw new Error('浮层未渲染（teleport 内容缺失）')
  return el as HTMLElement
}

/** 2026-09-04①：浮层首开后常驻——closed = display:none，不再是节点摘除 */
function menuVisible(): boolean {
  return menuEl().style.display !== 'none'
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('R39-3/R39-4：FontPicker 滚动与 Esc', () => {
  it('R39-3: 浮层自身滚动不关闭；浮层外滚动仍关闭（锚位失效语义保留）', async () => {
    wrapper = mount(FontPicker, { props: PROPS })
    await wrapper.find('button.font-picker').trigger('click')
    const menu = menuEl()
    // 修复前形态：菜单自身滚动（列表溢出滚动是常态）→ 首个滚动 tick 即关闭
    menu.dispatchEvent(new Event('scroll', { bubbles: true }))
    await Promise.resolve()
    expect(menuVisible()).toBe(true)
    // 浮层外滚动（页面滚动/容器滚动）仍按锚位失效关闭
    document.body.dispatchEvent(new Event('scroll', { bubbles: true }))
    await Promise.resolve()
    expect(menuVisible()).toBe(false)
  })

  it('R39-4: open 态 Esc 本层消费（defaultPrevented + 停止传播）；未 open 不消费', async () => {
    wrapper = mount(FontPicker, { props: PROPS })
    await wrapper.find('button.font-picker').trigger('click')
    // 捕获探针（组件捕获监听之后注册 → 同相位按注册序后跑）应看到 preventDefault 已生效
    let seenPrevented = false
    const captureProbe = (e: Event): void => {
      seenPrevented = (e as KeyboardEvent).defaultPrevented
    }
    window.addEventListener('keydown', captureProbe, true)
    // bubble 探针 = useHotkeys 同位（window bubble）：capture 期 stopPropagation 后不应到达
    let bubbleReached = false
    const bubbleProbe = (): void => {
      bubbleReached = true
    }
    window.addEventListener('keydown', bubbleProbe)
    // 真实场景按键 target 是焦点元素（body/按钮）而非 window——从 body 派发，
    // 捕获路径 window（组件消费）→ 目标，冒泡回 window 被 stopPropagation 截停
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await Promise.resolve() // Vue 反应式 flush（隐藏浮层在微任务，断言前让一拍）
    expect(menuVisible()).toBe(false) // 下拉关闭
    expect(seenPrevented).toBe(true)
    expect(bubbleReached).toBe(false) // useHotkeys 不再收到（不退专注）
    window.removeEventListener('keydown', captureProbe, true)
    window.removeEventListener('keydown', bubbleProbe)
    // 未 open：Esc 不消费（落到 useHotkeys 的原语义不变）
    const unconsumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(unconsumed)
    await Promise.resolve()
    expect(unconsumed.defaultPrevented).toBe(false)
  })

  it('2026-09-04①: 首开后浮层常驻——复开复用同一 DOM 节点（下拉延迟零重建闸）', async () => {
    wrapper = mount(FontPicker, { props: PROPS })
    // 未开过：不渲染（首开前零开销）
    expect(document.body.querySelector('.fp-menu')).toBeNull()
    await wrapper.find('button.font-picker').trigger('click')
    const first = menuEl()
    expect(menuVisible()).toBe(true)
    // 关闭（浮层外滚动）：元素留存于 DOM、display:none
    document.body.dispatchEvent(new Event('scroll', { bubbles: true }))
    await Promise.resolve()
    expect(menuVisible()).toBe(false)
    expect(document.body.querySelector('.fp-menu')).not.toBeNull()
    // 复开：同一节点（v-if 重建会换新节点）且重新可见
    await wrapper.find('button.font-picker').trigger('click')
    expect(menuEl()).toBe(first)
    expect(menuVisible()).toBe(true)
  })

  it('2026-09-04②: defaultFont——默认态按钮直显默认字体名；菜单首项「默认 · 名」保留重置入口', async () => {
    const CN: Record<string, string> = { 'Microsoft YaHei UI': '微软雅黑' }
    wrapper = mount(FontPicker, {
      props: { ...PROPS, defaultFont: 'Microsoft YaHei UI', display: (f: string): string => CN[f] ?? f },
    })
    // 按钮默认态：label/title 直显默认字体名（不再是「中文 · 默认」类占位）
    expect(wrapper.find('.fp-label').text()).toBe('微软雅黑')
    expect(wrapper.find('button.font-picker').attributes('title')).toBe('微软雅黑')
    // 按钮字体预览跟默认字体（闭合态所见即默认渲染）
    expect(wrapper.find('button.font-picker').attributes('style')).toContain('Microsoft YaHei UI')
    await wrapper.find('button.font-picker').trigger('click')
    const firstItem = document.body.querySelector('.fp-menu .fp-item')
    if (!(firstItem instanceof HTMLElement)) throw new Error('重置项缺失')
    expect(firstItem.textContent).toBe('默认 · 微软雅黑')
    // 选默认项 → emit('change', '')（重置回默认语义不变）
    firstItem.click()
    expect(wrapper.emitted('change')).toEqual([['']])
  })

  it('2026-09-04②: 无 defaultFont——回落 placeholder 旧形态', async () => {
    wrapper = mount(FontPicker, { props: PROPS })
    expect(wrapper.find('.fp-label').text()).toBe('默认字体')
    await wrapper.find('button.font-picker').trigger('click')
    expect(document.body.querySelector('.fp-menu .fp-item')?.textContent).toBe('默认字体')
  })

  it('2026-09-04②: useSystemFonts 默认解析——栈序取首个已安装；PROSE_FONT_FALLBACK 与 tokens 栈同源', async () => {
    // win 平台 mock（文件级 usePlatform mock isWin=true）：win UI 栈 = 雅黑 UI/雅黑 + Segoe UI
    const { systemFonts, defaultUiFontCn, defaultUiFontEn, defaultProseFontCn, defaultProseFontEn } = useSystemFonts()
    // 列表空 → 全退栈首（win 系统必装雅黑，实际不触达的兜底形态）
    expect(defaultUiFontCn.value).toBe('Microsoft YaHei UI')
    expect(defaultProseFontCn.value).toBe('LXGW WenKai')
    // 正文中英两槽默认同源（CJK 栈自带拉丁字形）
    expect(defaultProseFontEn.value).toBe('LXGW WenKai')
    // 列表加载后按实装收敛：无霞鹜 → 思源；英文槽雅黑 UI 在装 → 首选命中
    systemFonts.value = ['Noto Serif SC', 'Microsoft YaHei UI', 'Segoe UI']
    expect(defaultProseFontCn.value).toBe('Noto Serif SC')
    expect(defaultUiFontCn.value).toBe('Microsoft YaHei UI')
    expect(defaultUiFontEn.value).toBe('Segoe UI')
    // 回退串由栈派生（prefs apply() 与 tokens.css 默认栈单源）
    expect(PROSE_FONT_FALLBACK).toBe("'LXGW WenKai', 'Noto Serif SC', 'SimSun', serif")
  })
})
