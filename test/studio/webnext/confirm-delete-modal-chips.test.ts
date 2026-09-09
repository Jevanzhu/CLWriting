// @vitest-environment happy-dom
/**
 * R8B-P2-5（2026-09-09 修复批）：删除确认弹窗 chips 渲染上限。
 *
 * 修复前：批量全选千本级时确认弹窗逐名全量渲染 chips（「所见与所删」认知差 +
 * 千本级 DOM 膨胀）。修复：前 CHIP_CAP=50 个 + 尾部「…等 N 部」聚合 chip；
 * 顶部计数文案保持全量（「以下 N 本书」原文不动——总数认知不因裁剪受损）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import ConfirmDeleteModal from '../../../src/studio/web-next/src/components/ui/ConfirmDeleteModal.vue'

function queryChips(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.confirm-name'))
}

describe('R8B-P2-5: ConfirmDeleteModal chips 渲染上限', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('千本级名单：只渲染前 50 个 chips + 「…等 N 部」聚合；计数文案全量不虚', () => {
    const names = Array.from({ length: 120 }, (_, i) => `书${i}`)
    // Teleport 到 body——断言面查 document（wrapper 内找不到 teleport 内容）
    mount(ConfirmDeleteModal, { props: { names, deleting: false, error: null } })
    const chips = queryChips()
    expect(chips).toHaveLength(51) // 50 个 + 1 个聚合
    expect(chips[50]!.classList.contains('more')).toBe(true)
    expect(chips[50]!.textContent).toBe('…等 70 部')
    expect(document.body.textContent).toContain('120 本') // 全量计数不虚减
    expect(document.body.textContent).not.toContain('书51') // 裁剪线之后不再逐名渲染
  })

  it('小名单（≤ 上限）：逐名全量渲染、无聚合 chip（不误伤常规路径）', () => {
    mount(ConfirmDeleteModal, { props: { names: ['书A', '书B'], deleting: false, error: null } })
    const chips = queryChips()
    expect(chips).toHaveLength(2)
    expect(document.querySelector('.confirm-name.more')).toBeNull()
  })
})