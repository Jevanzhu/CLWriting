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
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('../../../src/studio/web-next/src/composables/usePlatform', () => ({
  usePlatform: () => ({ isWin: true, isMac: false }),
}))

import FontPicker from '../../../src/studio/web-next/src/components/ui/FontPicker.vue'

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
    expect(document.body.querySelector('.fp-menu')).not.toBeNull()
    // 浮层外滚动（页面滚动/容器滚动）仍按锚位失效关闭
    document.body.dispatchEvent(new Event('scroll', { bubbles: true }))
    await Promise.resolve()
    expect(document.body.querySelector('.fp-menu')).toBeNull()
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
    await Promise.resolve() // Vue 反应式 flush（v-if 摘除浮层在微任务，断言前让一拍）
    expect(document.body.querySelector('.fp-menu')).toBeNull() // 下拉关闭
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
})
