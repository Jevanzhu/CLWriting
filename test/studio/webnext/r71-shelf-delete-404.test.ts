/**
 * R71-26（七十一轮）回归：批量删书串行循环，部分失败后重试时已删书 404 直接抛 →
 * 后续书永远删不掉。
 *
 * 修复：循环内单书删除 catch 判 404/NOT_FOUND（ApiError 形状：status/code）视为已删
 * 继续；其余错误照旧中断记失败（弹窗保留可重试语义不变）。
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
// ApiError 用真实形状（useShelf 判 e instanceof ApiError + status/code）
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
  return { apiJson: vi.fn(), ApiError }
})

import { ApiError } from '../../../src/studio/web-next/src/api/client'
import { useShelf } from '../../../src/studio/web-next/src/composables/useShelf'

const notFound = () => new ApiError('没有这本书：书A', 404, 'NOT_FOUND')

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.shelfLoad.mockClear()
})

describe('R71-26: confirmDelete 部分失败后重试——已删书 404 视为已删继续', () => {
  it('三书删中间失败 → 重试：已删书A 404 不抛，继续删书B/书C 直至全部完成', async () => {
    // 首轮：A 成功、B 失败（500）→ 循环中断，C 未尝试
    mocks.deleteBook
      .mockResolvedValueOnce(undefined) // 书A
      .mockRejectedValueOnce(new ApiError('服务异常', 500, 'INTERNAL')) // 书B 中断
    const s = useShelf()
    s.requestDelete(['书A', '书B', '书C'])
    await s.confirmDelete()
    expect(s.deleteError.value).toBeTruthy()
    expect(s.confirmTarget.value).toEqual(['书A', '书B', '书C']) // 弹窗保留（重试带全量名单）
    expect(mocks.deleteBook).toHaveBeenCalledTimes(2)

    // 重试：A 已删（404）→ 视为已删继续；B/C 正常删完
    mocks.deleteBook.mockReset()
    mocks.deleteBook
      .mockRejectedValueOnce(notFound()) // 书A 重删 404
      .mockResolvedValueOnce(undefined) // 书B
      .mockResolvedValueOnce(undefined) // 书C
    await s.confirmDelete()
    expect(mocks.deleteBook).toHaveBeenCalledTimes(3) // 修复点：404 后循环不中断，书C 也删到（修复前停在书A）
    expect(s.confirmTarget.value).toBeNull() // 全部删完 → 弹窗关闭
    expect(s.batchMode.value).toBe(false)
    expect(mocks.shelfLoad).toHaveBeenCalled()
    // 注：deleteError 残留首轮文案是既有行为（成功路径不清、requestDelete 入口清），
    // 弹窗已关无展示面，不纳入本修复断言
  })

  it('非 404 错误照旧中断：重试遇 500 仍记失败、弹窗保留（守卫不放宽）', async () => {
    mocks.deleteBook
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(new ApiError('服务异常', 500, 'INTERNAL'))
    const s = useShelf()
    s.requestDelete(['书A', '书B'])
    await s.confirmDelete()
    expect(s.deleteError.value).toBeTruthy()
    expect(s.confirmTarget.value).toEqual(['书A', '书B']) // 弹窗保留可再重试
  })

  it('404 分支同样清误报灰显键（书已不存在，键不该留——幂等无实害）', async () => {
    mocks.deleteBook.mockRejectedValueOnce(notFound())
    const s = useShelf()
    s.requestDelete(['书A'])
    await s.confirmDelete()
    expect(mocks.clearFalsePositiveMarks).toHaveBeenCalledWith('书A')
  })
})
