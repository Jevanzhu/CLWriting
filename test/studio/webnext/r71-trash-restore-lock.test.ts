// @vitest-environment happy-dom
/**
 * R71-32（七十一轮）回归：TrashPanel.restore 无在途防重——双击第二笔 404 →
 * catch 置 err → 错误分支替换整个列表（恢复实际已成功）。
 *
 * 修复：restoring 在途锁（acting 同款）+ 404/NOT_FOUND 静默（条目已恢复）+
 * 其余失败收敛为 ui.toast（不覆盖列表）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
  purgeTrash: vi.fn(),
  treeLoad: vi.fn(async () => {}),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  listTrash: mocks.listTrash,
  restoreTrash: mocks.restoreTrash,
  purgeTrash: mocks.purgeTrash,
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => {
  class ApiError extends Error {
    status: number
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.code = code
    }
  }
  return { ApiError }
})
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => ({ load: mocks.treeLoad })),
}))

import { ApiError } from '../../../src/studio/web-next/src/api/client'
import TrashPanel from '../../../src/studio/web-next/src/components/panels/TrashPanel.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

const ENTRIES = [
  { id: 't1', path: '.trash/写作/正文/a.md', originalPath: '写作/正文/a.md' },
  { id: 't2', path: '.trash/写作/正文/b.md', originalPath: '写作/正文/b.md' },
]

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.listTrash.mockResolvedValue(ENTRIES)
})

function mountPanel() {
  return mount(TrashPanel, { props: { bookName: '书A' } })
}

describe('R71-32: TrashPanel restore 在途锁 + 404 静默 + 失败 toast', () => {
  it('双击 restore → 第二笔被在途锁挡，restoreTrash 只发一次', async () => {
    let resolveRestore!: (v: unknown) => void
    mocks.restoreTrash.mockReturnValue(new Promise((r) => (resolveRestore = r)))
    const w = mountPanel()
    await flushPromises()
    expect(w.find('.tree-list').exists()).toBe(true)

    await w.findAll('.action-btn')[0]!.trigger('click') // 第一笔（挂起中）
    await w.findAll('.action-btn')[0]!.trigger('click') // 双击第二笔
    expect(mocks.restoreTrash).toHaveBeenCalledTimes(1) // 修复点：在途锁挡第二笔（修复前两笔并发，第二笔必 404）

    resolveRestore({ ok: true })
    await flushPromises()
    expect(w.find('.tree-list').exists() || w.find('.empty-state').exists()).toBe(true)
    w.unmount()
  })

  it('迟到 404（第一笔已恢复成功）→ 不置全局 err、列表不被错误态替换', async () => {
    // 第一笔成功并刷新（t1 已从列表消失）；第二笔竞态迟到 404
    mocks.restoreTrash
      .mockResolvedValueOnce({ ok: true }) // 第一笔成功
      .mockRejectedValueOnce(new ApiError('回收站无 t1', 404, 'NOT_FOUND'))
    mocks.listTrash
      .mockResolvedValueOnce(ENTRIES) // 初载
      .mockResolvedValueOnce([{ ...ENTRIES[1]! }]) // 第一笔后 load（t1 已恢复）
    const w = mountPanel()
    await flushPromises()
    await w.findAll('.action-btn')[0]!.trigger('click')
    await flushPromises()
    expect(mocks.restoreTrash).toHaveBeenCalledTimes(1)

    // 双击的第二笔（模拟迟到竞态：直接调一次 restore）
    const vm = w.vm as unknown as { restore: (id: string) => Promise<void> }
    await vm.restore('t1')
    await flushPromises()

    // 修复点：404 静默——err 为 null，列表不整体变错误态（仍渲染列表/空态而非 .empty-state.err）
    expect(w.find('.empty-state.err').exists()).toBe(false)
    expect(useUiStore().toasts).toHaveLength(0) // 404 不 toast（恢复实际已成功）
    w.unmount()
  })

  it('非 404 失败 → toast 反馈、err 不置（列表保留可重试）', async () => {
    mocks.restoreTrash.mockRejectedValue(new ApiError('服务异常', 500, 'INTERNAL'))
    const w = mountPanel()
    await flushPromises()
    await w.findAll('.action-btn')[0]!.trigger('click')
    await flushPromises()

    const ui = useUiStore()
    expect(ui.toasts.at(-1)?.kind).toBe('error') // 修复点：失败收敛为 toast
    expect(w.find('.empty-state.err').exists()).toBe(false) // 不再覆盖整个列表
    expect(w.find('.tree-list').exists()).toBe(true) // 列表数据本身无恙
    w.unmount()
  })

  it('恢复成功（对照）→ load + tree.load 刷新，不 toast 不置 err', async () => {
    mocks.restoreTrash.mockResolvedValue({ ok: true })
    mocks.listTrash.mockResolvedValueOnce(ENTRIES).mockResolvedValueOnce([{ ...ENTRIES[1]! }])
    const w = mountPanel()
    await flushPromises()
    await w.findAll('.action-btn')[0]!.trigger('click')
    await flushPromises()

    expect(mocks.restoreTrash).toHaveBeenCalledWith('书A', 't1')
    expect(mocks.treeLoad).toHaveBeenCalledWith('书A')
    expect(useUiStore().toasts).toHaveLength(0)
    expect(w.find('.empty-state.err').exists()).toBe(false)
    w.unmount()
  })
})
