// @vitest-environment happy-dom
/**
 * R8B-P2-3（2026-09-09 修复批）：ModelPicker 补焦点陷阱 + dialog 语义。
 *
 * 修复前：弹窗族唯一无焦点陷阱/无 aria-modal/无初始聚焦——Tab 漏出到背后表单
 *（设置页其它输入），读屏无 dialog 边界。修复：useFocusTrap（对齐
 * ConfirmPrompt/SettingsModal/CreateBookModal R49-32 同族）+ role=dialog +
 * aria-modal + tabindex=-1；打开即落焦首个可交互元素（关闭钮，安全默认，
 * 与 ConfirmDeleteModal「危险操作默认聚焦安全项」同向）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import ModelPicker from '../../../src/studio/web-next/src/components/ui/ModelPicker.vue'

const PROPS = { show: true, candidates: ['gemini-1.5', 'claude-3.5', 'gpt-4o'], picked: new Set<string>() }

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('R8B-P2-3: ModelPicker 焦点陷阱 + dialog 语义', () => {
  it('容器具备 dialog 语义；打开即落焦首个可交互元素（关闭钮）', async () => {
    const w = mount(ModelPicker, { props: PROPS, attachTo: document.body })
    await nextTick()
    const pop = document.querySelector('.picker-pop') as HTMLElement
    expect(pop.getAttribute('role')).toBe('dialog')
    expect(pop.getAttribute('aria-modal')).toBe('true')
    expect(pop.getAttribute('tabindex')).toBe('-1')
    const first = pop.querySelector('button') as HTMLElement
    expect(document.activeElement).toBe(first) // 初始聚焦 = 头部关闭钮
    w.unmount()
  })

  it('Tab 在弹窗内循环：从末位包裹回首元素，不外漏到背后表单', async () => {
    const w = mount(ModelPicker, { props: PROPS, attachTo: document.body })
    await nextTick()
    const pop = document.querySelector('.picker-pop') as HTMLElement
    const focusables = pop.querySelectorAll<HTMLElement>('button, input')
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    last.focus()
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await nextTick()
    expect(document.activeElement).toBe(first) // 修复前：Tab 直穿到背后表单
    w.unmount()
  })

  it('Esc 关闭自身且不外溢（capture 消费语义保留）', () => {
    const w = mount(ModelPicker, { props: PROPS, attachTo: document.body })
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(e)
    expect(w.emitted('close')).toHaveLength(1)
    expect(e.defaultPrevented).toBe(true)
    w.unmount()
  })

  it('show=false 不渲染（未打开零 DOM）', () => {
    const w = mount(ModelPicker, { props: { ...PROPS, show: false }, attachTo: document.body })
    expect(document.body.querySelector('.picker-pop')).toBeNull()
    w.unmount()
  })
})