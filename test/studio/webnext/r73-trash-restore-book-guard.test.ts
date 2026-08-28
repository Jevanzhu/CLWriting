// @vitest-environment happy-dom
/**
 * R73-65（二十一轮批 E）回归：TrashPanel.restore 书名入口捕获。
 *
 * 修复前 restore 在 await 后用 props.bookName 触发 tree.load——恢复在途切书 A→B 时
 * 会对 B 书做 A 书语境的整树重扫（tree.load 扫全书，纯冗余）。修复后入口捕获书名，
 * await 后比对：仅未切书才重扫树；面板列表 load() 自带代守卫照常刷新；失败 toast
 * 同样不再落 B 书界面（R70-10 同族）。
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
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => ({ load: mocks.treeLoad })),
}))

import TrashPanel from '../../../src/studio/web-next/src/components/panels/TrashPanel.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { friendlyError } from '../../../src/studio/web-next/src/shared/error'

const ENTRIES = [{ id: 't1', path: '.trash/写作/正文/a.md', originalPath: '写作/正文/a.md' }]

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.listTrash.mockResolvedValue(ENTRIES)
})

describe('R73-65: restore 在途切书 → 不对新书整树重扫、失败 toast 不落新书', () => {
  it('restore 在途切书 A→B → tree.load 只刷 A 书，不重扫 B 书；restoreTrash 用 A 书名', async () => {
    let resolveRestore!: (v: unknown) => void
    mocks.restoreTrash.mockReturnValue(new Promise((r) => (resolveRestore = r)))
    mocks.listTrash
      .mockResolvedValueOnce(ENTRIES) // A 书初载
      .mockResolvedValueOnce([]) // 切书 watch → B 书列表载入
      .mockResolvedValueOnce([]) // restore 成功后的 load 刷新（此刻已切 B）

    const w = mount(TrashPanel, { props: { bookName: '书A' } })
    await flushPromises()

    await w.findAll('.action-btn')[0]!.trigger('click') // restore 挂起中
    expect(mocks.restoreTrash).toHaveBeenCalledWith('书A', 't1')

    // 恢复在途切书 A→B
    await w.setProps({ bookName: '书B' })
    await flushPromises()
    mocks.treeLoad.mockClear() // 排除切书 watch 之前的树刷历史

    resolveRestore({ ok: true })
    await flushPromises()

    // 修复点：A 的恢复不触发任何整树重扫（修复前会对当前书 B 做 tree.load 全书扫描；
    // A 书树重扫也无意义——切回 A 时 Book.vue watch 自然重载）
    expect(mocks.treeLoad).toHaveBeenCalledTimes(0)
    expect(mocks.treeLoad).not.toHaveBeenCalledWith('书B')
    expect(useUiStore().toasts).toHaveLength(0)
    w.unmount()
  })

  it('未切书（对照）→ restore 后 tree.load 照常刷原书', async () => {
    mocks.restoreTrash.mockResolvedValue({ ok: true })
    mocks.listTrash.mockResolvedValueOnce(ENTRIES).mockResolvedValueOnce([])
    const w = mount(TrashPanel, { props: { bookName: '书A' } })
    await flushPromises()
    await w.findAll('.action-btn')[0]!.trigger('click')
    await flushPromises()
    expect(mocks.treeLoad).toHaveBeenCalledWith('书A')
    w.unmount()
  })

  it('restore 失败且已切书 → 失败 toast 不落 B 书界面', async () => {
    const boom = new Error('服务异常')
    // 失败延后到切书之后才发生（已拒绝 promise 会在 setProps 前走完 catch，测不到守卫）
    let rejectRestore!: (e: unknown) => void
    mocks.restoreTrash.mockReturnValue(new Promise((_, rej) => (rejectRestore = rej)))
    mocks.listTrash
      .mockResolvedValueOnce(ENTRIES) // A 书初载
      .mockResolvedValueOnce([]) // B 书列表载入
    const w = mount(TrashPanel, { props: { bookName: '书A' } })
    await flushPromises()

    await w.findAll('.action-btn')[0]!.trigger('click') // restore 挂起中
    await w.setProps({ bookName: '书B' }) // 切书
    await flushPromises()

    rejectRestore(boom)
    await flushPromises()

    expect(useUiStore().toasts.some((t) => t.msg.includes(friendlyError(boom)))).toBe(false) // 修复点：不落 B 书
    w.unmount()
  })
})
