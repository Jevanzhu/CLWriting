// @vitest-environment happy-dom
/**
 * ModelPicker Esc 行为族（happy-dom）。
 * （原 r37-e-components 的 R37-36 节，按行为单拆。）
 *
 * R37-36（三十七轮批 E）：ModelPicker Esc 关闭自身且 stopPropagation，不外溢到外层
 * Esc 链；未开时不拦截；卸载后监听随之移除。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import ModelPicker from '../../../src/studio/web-next/src/components/ui/ModelPicker.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('R37-36: ModelPicker Esc 关闭自身且阻断外层 Esc 链', () => {
  it('show 时按 Esc → close 上抛且外层（window 冒泡监听）不触发', async () => {
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    const w = mount(ModelPicker, {
      props: { show: true, candidates: ['m1'], picked: new Set(['m1']) },
      attachTo: document.body,
    })

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()

    // 修复点：内层消费 Esc（close 上抛）且 stopPropagation——外层 useHotkeys/
    // SettingsModal 等同键链不同时触发（修复前 ModelPicker 无 Esc 处理，按键直穿）
    expect(w.emitted('close')).toHaveLength(1)
    expect(outer).not.toHaveBeenCalled()

    window.removeEventListener('keydown', outer)
    w.unmount()
  })

  it('show=false 时 Esc 不消费（未开的弹层不拦截外层按键）', async () => {
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    const w = mount(ModelPicker, {
      props: { show: false, candidates: [], picked: new Set<string>() },
      attachTo: document.body,
    })

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()

    expect(w.emitted('close')).toBeUndefined()
    expect(outer).toHaveBeenCalledTimes(1) // 让渡给外层

    window.removeEventListener('keydown', outer)
    w.unmount()
  })

  it('卸载后监听随之移除（不残留全局 keydown）', async () => {
    const w = mount(ModelPicker, {
      props: { show: true, candidates: [], picked: new Set<string>() },
      attachTo: document.body,
    })
    w.unmount()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(w.emitted('close')).toBeUndefined()
  })
})
