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
import { nextTick } from 'vue'

vi.mock('../../../src/studio/web-next/src/composables/usePlatform', () => ({
  usePlatform: () => ({ isWin: true, isMac: false }),
}))

import FontPicker from '../../../src/studio/web-next/src/components/ui/FontPicker.vue'
import {
  useSystemFonts,
  PROSE_FONT_FALLBACK_WIN,
  PROSE_FONT_SANS_FALLBACK_WIN,
  isSerifCnFont,
  proseFallbackTail,
} from '../../../src/studio/web-next/src/composables/useSystemFonts'
import { isFontInstalled, resolveInstalledFont } from '../../../src/studio/web-next/src/shared/font-names'

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
    // 回退串由栈派生（prefs apply() 与 tokens.css 默认栈单源；2026-09-08 双平台
    // 拆分后本文件锁 win 腿，mac 腿串见 prose-presets-mac.test.ts）
    expect(PROSE_FONT_FALLBACK_WIN).toBe("'LXGW WenKai', 'Noto Serif SC', 'SimSun', serif")
  })

  it('F0c②: 回退栈按中文字体族归边——衬线/书卷（宋·仿宋·楷·思源宋·文楷）挂衬线尾，其余挂无衬线尾', () => {
    expect(isSerifCnFont('SimSun')).toBe(true)
    expect(isSerifCnFont('NSimSun')).toBe(true)
    expect(isSerifCnFont('Noto Serif SC')).toBe(true)
    expect(isSerifCnFont('Source Han Serif SC')).toBe(true)
    expect(isSerifCnFont('LXGW WenKai')).toBe(true)
    expect(isSerifCnFont('Microsoft YaHei')).toBe(false)
    expect(isSerifCnFont('DengXian')).toBe(false)
    expect(isSerifCnFont('Noto Sans SC')).toBe(false)
    // CN 槽空维持衬线基座（出厂空槽口径不因分族而变）
    expect(proseFallbackTail('')).toBe(PROSE_FONT_FALLBACK_WIN)
    expect(proseFallbackTail('SimSun')).toBe(PROSE_FONT_FALLBACK_WIN)
    expect(proseFallbackTail('Noto Sans SC')).toBe(PROSE_FONT_SANS_FALLBACK_WIN)
    expect(PROSE_FONT_SANS_FALLBACK_WIN).toBe("'Microsoft YaHei', 'DengXian', 'SimHei', sans-serif")
  })

  it('F 线④: 族键对齐——zh-cn 中文名/思源=Noto 双产品异名同族；已装判定与候补落地', () => {
    const zh = ['微软雅黑', '宋体', '思源黑体']
    // 同一族的中文名/英文名互认：雅黑、宋体不再误报未装
    expect(isFontInstalled(zh, 'Microsoft YaHei')).toBe(true)
    expect(isFontInstalled(zh, 'SimSun')).toBe(true)
    // 思源黑体（Source Han Sans）= Noto Sans SC 同族互认
    expect(isFontInstalled(zh, 'Noto Sans SC')).toBe(true)
    expect(isFontInstalled(zh, 'DengXian')).toBe(false)
    // 候补落地：点击预设时取系统里第一个已装形态（CSS 直接命中真字体）
    expect(resolveInstalledFont(zh, 'Noto Sans SC')).toBe('思源黑体')
    expect(resolveInstalledFont(zh, 'Microsoft YaHei')).toBe('微软雅黑')
    expect(resolveInstalledFont(['Noto Sans SC'], 'Noto Sans SC')).toBe('Noto Sans SC')
  })
})

// R8C-F3（2026-09-09 修复批）：win 自绘浮层 listbox 键盘导航——此前 aria 声明
// combobox/listbox/option 契约但 onKey 仅 Esc（「声明即承诺」漂移）：无方向键、
// 无 aria-activedescendant。修复：roving 光标（键盘焦点留在触发按钮，光标经
// aria-activedescendant 移动）+ ↑/↓（APG listbox 不环绕）/Home/End/Enter/Space
// 选中/typeahead（800ms 窗前缀累计）/Tab 收菜单放行焦移。
describe('R8C-F3: FontPicker win 自绘浮层键盘导航', () => {
  async function pressKey(key: string, opts: KeyboardEventInit = {}): Promise<KeyboardEvent> {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
    document.body.dispatchEvent(e)
    await nextTick() // activeIdx/open 的反应式渲染 flush 后再断言
    return e
  }
  function activeItem(): HTMLElement {
    const el = document.body.querySelector('.fp-item.active')
    if (!(el instanceof HTMLElement)) throw new Error('roving 光标项缺失')
    return el
  }

  it('打开即定位当前值：aria-activedescendant 指向对应项；未开不消费', async () => {
    wrapper = mount(FontPicker, { props: { ...PROPS, value: 'Font5' } })
    await wrapper.find('button.font-picker').trigger('click')
    const btn = wrapper.find('button.font-picker').element
    const desc = btn.getAttribute('aria-activedescendant')
    expect(desc).not.toBeNull()
    expect(activeItem().id).toBe(desc) // 光标项 id 与 activedescendant 同源
    const items = document.body.querySelectorAll<HTMLElement>('.fp-menu .fp-item')
    expect(items[6]).toBe(activeItem()) // Font5 → 第 6 项（0 = 默认）
    // 未 open 的方向键不消费（菜单关闭态按键自然流，无副作用）
    await pressKey('ArrowDown')
    expect(wrapper.emitted('change')).toBeUndefined()
  })

  it('↑/↓ 逐项移动且不环绕；Home/End 首尾；Tab 收菜单放行焦移', async () => {
    wrapper = mount(FontPicker, { props: PROPS })
    await wrapper.find('button.font-picker').trigger('click')
    await pressKey('ArrowDown')
    expect(activeItem().id.endsWith('-opt-1')).toBe(true) // Font0
    await pressKey('ArrowDown')
    expect(activeItem().id.endsWith('-opt-2')).toBe(true) // Font1
    await pressKey('ArrowUp')
    expect(activeItem().id.endsWith('-opt-1')).toBe(true)
    await pressKey('ArrowUp')
    await pressKey('ArrowUp') // 顶项再上 → 停住（APG listbox 不环绕）
    expect(activeItem().id.endsWith('-opt-0')).toBe(true)
    await pressKey('End')
    expect(activeItem().id.endsWith(`-opt-${PROPS.fonts.length}`)).toBe(true) // 最末字体
    await pressKey('Home')
    expect(activeItem().id.endsWith('-opt-0')).toBe(true)
    const t = await pressKey('Tab') // 收菜单、不 preventDefault（放行焦移）
    expect(menuVisible()).toBe(false)
    expect(t.defaultPrevented).toBe(false)
  })

  it('Enter/Space 选中 roving 光标项并关闭；Space 不再触发按钮反转', async () => {
    wrapper = mount(FontPicker, { props: PROPS })
    await wrapper.find('button.font-picker').trigger('click')
    await pressKey('Enter') // 光标 0 = 默认项 → 重置
    expect(wrapper.emitted('change')).toEqual([['']])
    expect(menuVisible()).toBe(false)
    await wrapper.find('button.font-picker').trigger('click') // 复开
    await pressKey('ArrowDown')
    await pressKey('ArrowDown')
    await pressKey(' ') // Space = 选中当前（Font1）；若不拦会触发按钮默认激活反转菜单
    expect(wrapper.emitted('change')?.at(-1)).toEqual(['Font1'])
    expect(menuVisible()).toBe(false)
  })

  it('typeahead：可打印字符按前缀移动光标（累计窗）；未命中保持原位', async () => {
    wrapper = mount(FontPicker, { props: PROPS })
    await wrapper.find('button.font-picker').trigger('click')
    await pressKey('f')
    expect(activeItem().id.endsWith('-opt-1')).toBe(true) // f → Font0
    await pressKey('o')
    expect(activeItem().id.endsWith('-opt-2')).toBe(true) // fo → Font1（从当前之后找）
    await pressKey('n')
    expect(activeItem().id.endsWith('-opt-3')).toBe(true) // fon → Font2（累计前缀生效）
    await pressKey('3') // fon3 无前缀命中 → 原位
    expect(activeItem().id.endsWith('-opt-3')).toBe(true)
  })

  it('IME 组合期 Esc 让渡不关闭（R50-D1-1）；松开组合后 Esc 正常收菜单', async () => {
    // dev 线重评-P2-2 同题用例随 win←dev 合并移植（契约并至 R8C-F3 版）
    wrapper = mount(FontPicker, { props: PROPS })
    await wrapper.find('button.font-picker').trigger('click')
    await pressKey('Escape', { isComposing: true })
    expect(menuVisible()).toBe(true) // 组合期收候选的 Esc 不连带关下拉
    await pressKey('Escape')
    expect(menuVisible()).toBe(false)
  })
})

// R0911-C2-P3-1（2026-09-11 全量重评 GLM-5.3 修复批）：实例 id 取号器原写 <script setup>
// 内（每实例归零再自增、uid 恒为 1）——双开 FontPicker（设置弹窗 + 专注排版条等）时
// 两实例 optId 全同名：DOM 重复 id + aria-activedescendant 互串指到对方菜单项。
// 修后取号器提模块级，跨实例单调。id 面只在 win 自绘路径渲染（非 win 原生 select 不产
// optId），故用例锁 win 腿即覆盖全部 id 产出面。
describe('R0911-C2-P3-1: FontPicker 双开实例 id 互异', () => {
  it('两实例同时打开——菜单项 id 全表互异，aria-activedescendant 各指本实例项', async () => {
    const w1 = mount(FontPicker, { props: { ...PROPS, value: 'Font1' } })
    const w2 = mount(FontPicker, { props: { ...PROPS, value: 'Font2' } })
    try {
      await w1.find('button.font-picker').trigger('click')
      await w2.find('button.font-picker').trigger('click')
      const menus = document.body.querySelectorAll('.fp-menu')
      expect(menus).toHaveLength(2) // 双开：两套浮层并存于 body
      const ids1 = [...menus[0]!.querySelectorAll('.fp-item')].map((el) => el.id)
      const ids2 = [...menus[1]!.querySelectorAll('.fp-item')].map((el) => el.id)
      expect(ids1).toHaveLength(PROPS.fonts.length + 1) // 默认项 + 30 字体
      // 修复点：修复前两实例 uid 同为 1，id 逐项同名（Set 尺寸 ≈ 单表）；修后全表互异
      expect(new Set([...ids1, ...ids2]).size).toBe(ids1.length + ids2.length)
      // aria 互串面：activedescendant 只在本实例菜单项集合内命中（对方表无此 id）
      const b1 = w1.find('button.font-picker').element.getAttribute('aria-activedescendant')
      const b2 = w2.find('button.font-picker').element.getAttribute('aria-activedescendant')
      expect(ids1).toContain(b1) // w1 值 Font1 → 光标在本表 opt-2
      expect(ids2).toContain(b2) // w2 值 Font2 → 光标在本表 opt-3
      expect(ids2).not.toContain(b1) // 不再互串指到对方表
    } finally {
      w1.unmount()
      w2.unmount()
    }
  })
})

// R0910-W（2026-09-10 修复批）：卸载回收 typeahead 800ms 复位定时器——组件销毁后
// 回调仍会触发（对已销毁实例的闭包写 typeBuf，纯泄漏）；随监听器一并 clearTimeout。
describe('R0910-W: FontPicker 卸载清 typeahead 定时器', () => {
  it('typeahead 排定的复位定时器随卸载清理，不残留', async () => {
    vi.useFakeTimers()
    try {
      wrapper = mount(FontPicker, { props: PROPS })
      await wrapper.find('button.font-picker').trigger('click')
      const baseline = vi.getTimerCount()
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }))
      expect(vi.getTimerCount()).toBe(baseline + 1) // typeahead 复位定时器已排定
      wrapper.unmount()
      wrapper = null
      expect(vi.getTimerCount()).toBe(baseline) // 随卸载清理，不残留
    } finally {
      vi.useRealTimers()
    }
  })
})
