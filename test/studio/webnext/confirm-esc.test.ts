// @vitest-environment happy-dom
/**
 * B-8（第六十轮）回归：ConfirmPrompt 的 Esc 消费。
 * useHotkeys 对 confirmState 让渡「Esc 归自身处理」，但确认框原先无键盘面——
 * 让渡契约有让无收，确认框期间 Esc 死键。修复：document capture 监听
 * Escape → preventDefault + resolveConfirm(false)（对齐 Z-23 弹层 Esc 模式）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import ConfirmPrompt from '../../../src/studio/web-next/src/components/ui/ConfirmPrompt.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
})

function pressEsc(): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  document.dispatchEvent(e)
  return e
}

describe('B-8: ConfirmPrompt Esc 消费', () => {
  it('确认框打开 → Esc 被消费（preventDefault）并按取消收口', async () => {
    const ui = useUiStore()
    const w = mount(ConfirmPrompt, { attachTo: document.body })
    const p = ui.ask({ title: '删除章节', message: '确认？', danger: true })
    expect(ui.confirmState).not.toBeNull()

    const e = pressEsc()
    expect(e.defaultPrevented).toBe(true) // 全局层 defaultPrevented 让渡链成立
    await expect(p).resolves.toBe(false)
    expect(ui.confirmState).toBeNull()
    w.unmount()
  })

  it('确认框未打开 → Esc 不消费不误伤', () => {
    const ui = useUiStore()
    const w = mount(ConfirmPrompt, { attachTo: document.body })
    const e = pressEsc()
    expect(e.defaultPrevented).toBe(false)
    expect(ui.confirmState ?? null).toBeNull()
    w.unmount()
  })

  it('卸载后监听摘除 → Esc 不再被消费（无监听器泄漏）', async () => {
    const ui = useUiStore()
    const w = mount(ConfirmPrompt, { attachTo: document.body })
    const p = ui.ask({ title: 't', message: 'm' })
    w.unmount()
    const e = pressEsc()
    expect(e.defaultPrevented).toBe(false)
    // 弹窗已卸载：Esc 不再驱动确认框，Promise 由后续 resolveConfirm/新弹窗收口
    void p
    expect(ui.confirmState).not.toBeNull()
    ui.resolveConfirm(false)
    await expect(p).resolves.toBe(false)
  })
})
