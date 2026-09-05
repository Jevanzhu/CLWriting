// @vitest-environment happy-dom
/**
 * R49-32（四十九轮）：CreateBookModal 补焦点圈 + dialog 语义（对齐 ConfirmDeleteModal
 * R37-33 同族）——接 useFocusTrap：打开即聚焦（定向书名输入）、Tab/Shift+Tab 循环
 * 不出弹窗；容器补 role="dialog" + aria-modal="true" + tabindex="-1"。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import CreateBookModal from '../../../src/studio/web-next/src/components/ui/CreateBookModal.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

function mountModal() {
  // name 非空：创建按钮不 disabled（disabled 元素不可聚焦，Tab 圈会退化）
  return mount(
    CreateBookModal,
    { props: { name: '雪中', kind: 'long' as const, creating: false, error: null }, attachTo: document.body },
  )
}

describe('R49-32: CreateBookModal 焦点圈 + dialog 语义', () => {
  it('挂载后初始焦点落书名输入（首个输入），容器具备 dialog 语义', async () => {
    const w = mountModal()
    await nextTick()

    const dialog = document.querySelector('.create-modal') as HTMLElement
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('tabindex')).toBe('-1')
    // 初始焦点：书名输入（弹窗主路径）——非 trap 默认的第一个可交互元素（长篇钮）
    expect(document.activeElement).toBe(dialog.querySelector('input.input'))

    w.unmount()
  })

  it('Tab / Shift+Tab 在弹窗内循环，不出弹窗', async () => {
    const w = mountModal()
    await nextTick()
    const dialog = document.querySelector('.create-modal') as HTMLElement
    const btns = dialog.querySelectorAll('button')
    expect(btns.length).toBe(4) // 长篇 / 短篇 / 取消 / 创建

    const first = btns[0] as HTMLElement // trap 圈内第一个可交互元素 = 长篇
    const last = btns[btns.length - 1] as HTMLElement // 最后一个 = 创建

    // Tab 从最后一个（创建）→ 包裹回第一个（长篇）
    last.focus()
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await nextTick()
    expect(document.activeElement).toBe(first)

    // Shift+Tab 从第一个（长篇）→ 包裹到最后一个（创建）：循环锁在弹窗内
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    )
    await nextTick()
    expect(document.activeElement).toBe(last)

    w.unmount()
  })
})
