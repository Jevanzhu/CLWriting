// @vitest-environment happy-dom
/**
 * R35-38（三十五轮批 E）回归：useHotkeys ⌘P 在任一弹层打开时让渡。
 * 修复前 ⌘P 无条件 openPalette——面板与弹层同 z-index 时后者后挂载压住前者，
 * 再按 ⌘P 开出的是被遮住的「隐形面板」。修复后对齐上方 Esc 的让渡名单
 * （palette/confirm/settings/export/shelf），有弹层时 ⌘P 不消费不 preventDefault。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { useHotkeys } from '../../../src/studio/web-next/src/composables/useHotkeys'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

const Host = defineComponent({ setup: () => { useHotkeys(); return () => '' } })

function pressCmdP(): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'p', metaKey: true, cancelable: true })
  window.dispatchEvent(e)
  return e
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('R35-38: useHotkeys ⌘P 弹层让渡', () => {
  it('无弹层 → ⌘P 打开命令面板（行为不回退）', () => {
    mount(Host)
    const ui = useUiStore()
    pressCmdP()
    expect(ui.paletteOpen).toBe(true)
  })

  it('设置弹层打开 → ⌘P 让渡：不开面板、不 preventDefault', () => {
    mount(Host)
    const ui = useUiStore()
    ui.settingsOpen = true
    const e = pressCmdP()
    expect(ui.paletteOpen).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })

  it('确认框打开（confirmState）→ ⌘P 同样让渡', () => {
    mount(Host)
    const ui = useUiStore()
    void ui.ask({ title: '确认', message: '测试' })
    const e = pressCmdP()
    expect(ui.paletteOpen).toBe(false)
    expect(e.defaultPrevented).toBe(false)
    ui.confirmState?.resolve(false) // 清理挂起的确认 promise
  })
})
