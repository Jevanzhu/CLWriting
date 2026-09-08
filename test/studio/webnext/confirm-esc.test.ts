// @vitest-environment happy-dom
/**
 * B-8（第六十轮）回归：ConfirmPrompt 的 Esc 消费。
 * useHotkeys 对 confirmState 让渡「Esc 归自身处理」，但确认框原先无键盘面——
 * 让渡契约有让无收，确认框期间 Esc 死键。修复：document capture 监听
 * Escape → preventDefault + resolveConfirm(false)（对齐 Z-23 弹层 Esc 模式）。
 *
 * 重评-P3-18（2026-09-09 全量代码重评）：ConfirmDeleteModal 同族——Esc 原外放宿主
 * （Shelf/ShelfModal onKeydown 代管），键盘面外放、组件单独挂载即死键。修后组件
 * document capture 自持（含 IME 让渡 + stopPropagation 防宿主同键双效），宿主只摘
 * 本弹窗分支、其余浮层分支保留。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import ConfirmPrompt from '../../../src/studio/web-next/src/components/ui/ConfirmPrompt.vue'
import ConfirmDeleteModal from '../../../src/studio/web-next/src/components/ui/ConfirmDeleteModal.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
})

function pressEsc(target: EventTarget = document): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  target.dispatchEvent(e)
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

describe('重评-P3-18: ConfirmDeleteModal Esc 自持（宿主 handler 摘分支后语义不变）', () => {
  function mountModal(props: Partial<{ deleting: boolean }> = {}) {
    return mount(ConfirmDeleteModal, {
      props: { names: ['书A', '书B'], deleting: false, error: null, ...props },
      attachTo: document.body,
    })
  }

  it('打开态 Esc → 本组件消费（preventDefault）并 emit cancel', async () => {
    const w = mountModal()
    const e = pressEsc()
    expect(e.defaultPrevented).toBe(true)
    expect(w.emitted('cancel')).toHaveLength(1)
    w.unmount()
  })

  it('IME 组合期 Esc 让渡：不消费不取消', () => {
    const w = mountModal()
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })
    document.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(w.emitted('cancel')).toBeUndefined()
    w.unmount()
  })

  it('非 Esc 键不误伤', () => {
    const w = mountModal()
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    document.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(w.emitted('cancel')).toBeUndefined()
    w.unmount()
  })

  it('卸载后监听摘除 → Esc 不再被消费（无监听器泄漏）', () => {
    const w = mountModal()
    w.unmount()
    const e = pressEsc()
    expect(e.defaultPrevented).toBe(false)
  })

  it('宿主源码锚定：Shelf/ShelfModal 只摘本弹窗分支，其余浮层分支与组件接线保留', () => {
    const read = (p: string): string => readFileSync(resolve(__dirname, p), 'utf-8')
    const shelfSrc = read('../../../src/studio/web-next/src/pages/Shelf.vue')
    const modalSrc = read('../../../src/studio/web-next/src/components/ui/ShelfModal.vue')
    const compSrc = read('../../../src/studio/web-next/src/components/ui/ConfirmDeleteModal.vue')
    // 本弹窗分支已从两宿主摘除
    expect(shelfSrc).not.toContain('confirmTarget.value) cancelDelete')
    expect(modalSrc).not.toContain('if (confirmTarget.value) { cancelDelete(); consumed = true }')
    // 其余浮层分支保留（建书 / 批量 / 收层）
    expect(shelfSrc).toContain('showCreate.value = false')
    expect(shelfSrc).toContain('exitBatch()')
    expect(modalSrc).toContain('showCreate.value = false')
    expect(modalSrc).toContain('exitBatch()')
    expect(modalSrc).toContain('ui.closeShelf()')
    // 组件自持接线：document capture 注册 + 成对摘除
    expect(compSrc).toContain("document.addEventListener('keydown', onKeydown, true)")
    expect(compSrc).toContain("document.removeEventListener('keydown', onKeydown, true)")
    expect(compSrc).toContain('isImeComposing')
  })
})
