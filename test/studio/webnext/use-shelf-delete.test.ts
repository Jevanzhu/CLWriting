/**
 * R65-54（十三轮批 E-6）回归：useShelf.confirmDelete 成功后 onDeleted 回调。
 * ShelfModal 借它在「删掉当前打开的书」时导航离开死路由 /book/:name——
 * 回调契约：成功（全部删完）必调且带全量名单；失败不调（保留弹窗重试语义）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  deleteBook: vi.fn(),
  clearFalsePositiveMarks: vi.fn(),
  shelfLoad: vi.fn(async () => {}),
}))
vi.mock('../../../src/studio/web-next/src/api/shelf', () => ({ deleteBook: mocks.deleteBook }))
vi.mock('../../../src/studio/web-next/src/stores/check', () => ({ clearFalsePositiveMarks: mocks.clearFalsePositiveMarks }))
vi.mock('../../../src/studio/web-next/src/stores/shelf', () => ({
  useShelfStore: vi.fn(() => ({ books: [], load: mocks.shelfLoad })),
}))
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: vi.fn(() => ({ shelfView: 'grid', setShelfView: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({ apiJson: vi.fn() }))

import { useShelf } from '../../../src/studio/web-next/src/composables/useShelf'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.shelfLoad.mockClear()
})

describe('useShelf: confirmDelete onDeleted 回调（R65-54）', () => {
  it('删除成功 → onDeleted 带全量名单（外壳导航离开死路由的钩子）', async () => {
    mocks.deleteBook.mockResolvedValue(undefined)
    const onDeleted = vi.fn()
    const s = useShelf({ onDeleted })
    s.requestDelete(['书A', '书B'])
    await s.confirmDelete()
    expect(mocks.deleteBook).toHaveBeenCalledTimes(2)
    expect(onDeleted).toHaveBeenCalledTimes(1)
    expect(onDeleted).toHaveBeenCalledWith(['书A', '书B'])
  })

  it('删除失败 → onDeleted 不调（部分删除的外壳导航不该发生，弹窗保留可重试）', async () => {
    mocks.deleteBook.mockRejectedValueOnce(new Error('server 500'))
    const onDeleted = vi.fn()
    const s = useShelf({ onDeleted })
    s.requestDelete(['书A'])
    await s.confirmDelete()
    expect(s.deleteError.value).toBeTruthy()
    expect(s.confirmTarget.value).toEqual(['书A']) // 弹窗保留
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('未传 onDeleted → 不炸（Shelf.vue 全屏页无当前书语境，不守卫）', async () => {
    mocks.deleteBook.mockResolvedValue(undefined)
    const s = useShelf()
    s.requestDelete(['书A'])
    await expect(s.confirmDelete()).resolves.toBeUndefined()
    expect(s.batchMode.value).toBe(false)
  })
})
