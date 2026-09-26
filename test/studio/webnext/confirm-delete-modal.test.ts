// @vitest-environment happy-dom
/**
 * ConfirmDeleteModal 删除确认弹窗行为族（happy-dom）。
 * （原 r29-components-zero-coverage 的 R29-13 节，按行为单拆。）
 *
 * R29-13（二十九轮批 F）：组件面零直测补齐——渲染计数文案 + 书名清单、确认/取消按钮
 * 事件上抛、遮罩点击自身取消（@click.self）、error prop 错误条、deleting 危险态
 * （双按钮禁用 + 确认钮切「删除中…」）。teleport stub：内容留在 wrapper 内，事件与
 * DOM 同体断言（VTU 惯例）。
 * R37-33（三十七轮批 E）：接 useFocusTrap——打开时焦点落取消按钮（危险操作默认安全
 * 项），Tab 循环不出弹窗（原 r37-e-components 的 R37-33 节并入）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ConfirmDeleteModal from '../../../src/studio/web-next/src/components/ui/ConfirmDeleteModal.vue'

describe('R29-13 ConfirmDeleteModal 删除确认弹窗', () => {
  function mountModal(props: Partial<{ names: string[]; deleting: boolean; error: string | null }> = {}) {
    return mount(ConfirmDeleteModal, {
      props: {
        names: props.names ?? ['书甲', '书乙'],
        deleting: props.deleting ?? false,
        error: props.error ?? null,
      },
      // teleport stub：内容留在 wrapper 内，事件与 DOM 同体断言（VTU 惯例）
      global: { stubs: { teleport: true } },
    })
  }

  it('渲染计数文案 + 书名清单；确认/取消按钮上抛对应事件', async () => {
    const wrapper = mountModal()
    expect(wrapper.find('.confirm-text').text()).toContain('2 本书')
    expect(wrapper.findAll('.confirm-name').map((n) => n.text())).toEqual(['书甲', '书乙'])
    expect(wrapper.find('.confirm-err').exists()).toBe(false)
    expect(wrapper.find('.confirm-icon-danger').exists()).toBe(true) // 危险态图标

    await wrapper.find('.btn.danger').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    await wrapper.findAll('.btn')[0]!.trigger('click') // 取消按钮在首位
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('遮罩点击自身 → cancel（@click.self）', async () => {
    const wrapper = mountModal()
    await wrapper.find('.confirm-overlay').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('error prop → 错误条渲染', () => {
    const wrapper = mountModal({ error: '删除失败：网络错误' })
    expect(wrapper.find('.confirm-err').text()).toBe('删除失败：网络错误')
  })

  it('deleting=true → 双按钮禁用、确认按钮切「删除中…」', () => {
    const wrapper = mountModal({ deleting: true })
    const btns = wrapper.findAll('.btn')
    expect(btns.map((b) => (b.element as HTMLButtonElement).disabled)).toEqual([true, true])
    expect(wrapper.find('.btn.danger').text()).toBe('删除中…')
  })
})

// ── R37-33：焦点圈 + 默认聚焦取消 ────────────────────────────────────────

describe('R37-33: ConfirmDeleteModal 焦点圈 + 默认聚焦取消', () => {
  it('挂载后焦点在取消按钮（危险操作默认安全项），Tab 循环不出弹窗', async () => {
    const w = mount(ConfirmDeleteModal, {
      props: { names: ['书A'], deleting: false, error: null },
      attachTo: document.body,
    })
    await nextTick()

    const dialog = document.querySelector('.confirm-dialog') as HTMLElement
    expect(dialog.getAttribute('role')).toBe('dialog')
    const btns = document.querySelectorAll('.confirm-actions .btn')
    expect(btns.length).toBe(2)
    // 修复点：trap 落焦第一个可交互元素 = 取消按钮（修复前无 focus trap，焦点留背景）
    expect(document.activeElement).toBe(btns[0])

    // Shift+Tab 从取消（first）→ 包裹到确认删除（last）：Tab 循环不出弹窗
    btns[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    await nextTick()
    expect(document.activeElement).toBe(btns[1])

    w.unmount()
  })
})
