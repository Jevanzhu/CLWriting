// @vitest-environment happy-dom
/**
 * TrashPanel.purge 在途锁 + 404 收敛行为族（happy-dom）。
 * （原 r34d-e2-panels 的 R34D-29 节，按行为单拆。）
 *
 * R34D-29（三十四轮批 E2）：purge 无在途锁无 404 静默（restore 三者全有 R71-32 同型）；
 * 修复 = purge 在途锁（含确认弹窗滞留期）+ 404 按已删收敛（静默 + load 对齐）；
 * 非 404 失败仍置 err（R76-32 口径保留）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
  purgeTrash: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  listTrash: mocks.listTrash,
  restoreTrash: mocks.restoreTrash,
  purgeTrash: mocks.purgeTrash,
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  createDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => ({})),
  getGlobalPrefs: vi.fn(async () => ({})),
  putGlobalPrefs: vi.fn(async () => ({})),
}))
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})

import { ApiError } from '../../../src/studio/web-next/src/api/client'
import TrashPanel from '../../../src/studio/web-next/src/components/panels/TrashPanel.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

const TRASH_ENTRIES = [
  { id: 't1', path: '.trash/写作/正文/a.md', originalPath: '写作/正文/a.md' },
  { id: 't2', path: '.trash/写作/正文/b.md', originalPath: '写作/正文/b.md' },
]

function mountTrashPanel() {
  mocks.listTrash.mockResolvedValue(TRASH_ENTRIES)
  return mount(TrashPanel, { props: { bookName: '书A' } })
}

/** 点 purge 按钮并确认弹窗（驱动真实 ui store 的命令式 ask） */
async function purgeAndConfirm(w: ReturnType<typeof mount>, row: number): Promise<void> {
  await w.findAll('.action-btn.danger')[row]!.trigger('click')
  useUiStore().resolveConfirm(true)
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('R34D-29: TrashPanel purge 在途锁 + 404 收敛静默', () => {
  it('确认弹窗滞留期双击 → 第二笔被在途锁挡，purgeTrash 只发一次', async () => {
    mocks.purgeTrash.mockResolvedValue({ ok: true })
    const w = mountTrashPanel()
    await flushPromises()
    const btn = w.findAll('.action-btn.danger')[0]!

    await btn.trigger('click') // 第一笔：弹确认（锁已置）
    const ui = useUiStore()
    expect(ui.confirmState).not.toBeNull()
    await btn.trigger('click') // 双击第二笔（弹窗滞留期）→ 在途锁挡
    expect(mocks.purgeTrash).not.toHaveBeenCalled()

    ui.resolveConfirm(true)
    await flushPromises()
    // 修复点：仅一笔请求（修复前第二笔在第一笔完成后必 404）
    expect(mocks.purgeTrash).toHaveBeenCalledTimes(1)
    expect(mocks.purgeTrash).toHaveBeenCalledWith('书A', 't1')
    w.unmount()
  })

  it('请求在途时点另一条 purge → 被在途锁挡（不弹第二个确认框）', async () => {
    let resolvePurge!: (v: unknown) => void
    mocks.purgeTrash.mockReturnValue(new Promise((r) => (resolvePurge = r)))
    const w = mountTrashPanel()
    await flushPromises()

    await purgeAndConfirm(w, 0) // t1 请求在途（purging 持锁）
    expect(mocks.purgeTrash).toHaveBeenCalledTimes(1)
    await w.findAll('.action-btn.danger')[1]!.trigger('click') // t2 第二笔
    expect(useUiStore().confirmState).toBeNull() // 修复点：锁挡，未弹第二个确认框

    resolvePurge({ ok: true })
    await flushPromises()
    expect(mocks.purgeTrash).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('确认取消 → 锁释放，后续 purge 正常可发（锁不泄漏）', async () => {
    mocks.purgeTrash.mockResolvedValue({ ok: true })
    const w = mountTrashPanel()
    await flushPromises()
    await w.findAll('.action-btn.danger')[0]!.trigger('click')
    useUiStore().resolveConfirm(false)
    await flushPromises()
    expect(mocks.purgeTrash).not.toHaveBeenCalled()

    await purgeAndConfirm(w, 0) // 取消后重发：锁已释放，正常走通
    expect(mocks.purgeTrash).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('迟到 404（条目已被清）→ 静默 + load 对齐列表，不覆盖成假错误态', async () => {
    mocks.purgeTrash.mockRejectedValue(new ApiError('回收站无此条目', 404, 'NOT_FOUND'))
    mocks.listTrash
      .mockResolvedValueOnce(TRASH_ENTRIES)
      .mockResolvedValueOnce([TRASH_ENTRIES[1]!]) // 404 收敛 load：t1 已不在
    const w = mountTrashPanel()
    await flushPromises()

    await purgeAndConfirm(w, 0)
    // 修复点：404 按已删收敛——面板不被错误态覆盖、无 toast
    expect(w.find('.empty-state.err').exists()).toBe(false)
    expect(useUiStore().toasts).toHaveLength(0)
    expect(mocks.listTrash).toHaveBeenCalledTimes(2) // 初载 + 404 收敛刷新
    expect(w.findAll('.tree-item')).toHaveLength(1) // 列表对齐（t1 已删）
    w.unmount()
  })

  it('守恒：非 404 失败仍置 err 提示（R76-32 口径保留）', async () => {
    mocks.purgeTrash.mockRejectedValue(new ApiError('服务异常', 500, 'INTERNAL'))
    const w = mountTrashPanel()
    await flushPromises()
    await purgeAndConfirm(w, 0)
    expect(w.find('.empty-state.err').exists()).toBe(true)
    w.unmount()
  })
})
