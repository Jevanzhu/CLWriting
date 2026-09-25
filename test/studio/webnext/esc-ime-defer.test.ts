// @vitest-environment happy-dom
/**
 * R50-D1-1（五十轮）回归：Esc 关闭下拉的 IME 组合期让渡。
 * - TabBar 新建下拉（onDocKeydown Escape 分支）与 FontPicker win 自绘浮层（onKey）
 *   原缺 isImeComposing 守卫：组合期收输入法候选的 Esc 会连带关闭下拉。
 * - 修后对齐 ModelPicker/SettingsModal/CommandPalette 等先例口径：组合期
 *（isComposing）Esc 让渡输入法（不关闭不消费）；非组合期 Esc 照常关闭。
 * 真实 KeyboardEvent 直派（VTU trigger 对 isComposing init 键透传不可靠，r61 同款）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// FontPicker win 分支（自绘浮层）走 isWin；TabBar 不受影响（平台三态均为 false）
vi.mock('../../../src/studio/web-next/src/composables/usePlatform', () => ({
  usePlatform: () => ({ isDesktop: false, platform: null, isMac: false, isWin: true }),
}))

import TabBar from '../../../src/studio/web-next/src/components/shell/TabBar.vue'
import FontPicker from '../../../src/studio/web-next/src/components/ui/FontPicker.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('R50-D1-1: TabBar 新建下拉 Esc 的 IME 组合期让渡', () => {
  it('组合期 Esc 不关闭不消费；非组合期 Esc 照常关闭', async () => {
    // R0912-3 #9：TabBar bookName 死 prop 已删，无 props
    const w = mount(TabBar, { attachTo: document.body })
    // 打开下拉（caret 点击出 Teleport 菜单）
    await w.find('.tb-caret').trigger('click')
    expect(document.body.querySelector('.new-dropdown')).not.toBeNull()

    // IME 组合期 Esc（收候选）：让渡输入法——不关闭、不消费
    const composingEsc = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(composingEsc)
    await Promise.resolve()
    expect(document.body.querySelector('.new-dropdown')).not.toBeNull() // 修复点：不关闭
    expect(composingEsc.defaultPrevented).toBe(false) // 不消费（Esc 归输入法）

    // 非组合期 Esc：照常关闭（R33-90 路径保留）
    const realEsc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(realEsc)
    await Promise.resolve()
    expect(document.body.querySelector('.new-dropdown')).toBeNull()
    w.unmount()
  })
})

describe('R50-D1-1: FontPicker（win 自绘浮层）Esc 的 IME 组合期让渡', () => {
  const PROPS = { value: '', fonts: ['FontA'], placeholder: '默认字体', display: (f: string): string => f }

  it('组合期 Esc 不关闭不消费；非组合期 Esc 本层消费照常关闭（R39-4 语义保留）', async () => {
    const w = mount(FontPicker, { props: PROPS })
    await w.find('button.font-picker').trigger('click')
    const menu = document.body.querySelector('.fp-menu')
    expect(menu).not.toBeNull()
    // 2026-09-04 常驻契约：closed = display:none
    expect((menu as HTMLElement).style.display).not.toBe('none')

    // IME 组合期 Esc：capture 监听让渡——不关闭、不消费（防打断输入法候选）
    const composingEsc = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(composingEsc)
    await Promise.resolve()
    expect((menu as HTMLElement).style.display).not.toBe('none') // 修复点：不关闭
    expect(composingEsc.defaultPrevented).toBe(false) // 不消费（Esc 归输入法）

    // 非组合期 Esc：R39-4 本层消费语义保留（关闭 + preventDefault）
    const realEsc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(realEsc)
    await Promise.resolve()
    expect((menu as HTMLElement).style.display).toBe('none')
    expect(realEsc.defaultPrevented).toBe(true)
    w.unmount()
  })
})
