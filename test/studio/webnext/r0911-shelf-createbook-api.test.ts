/**
 * R0911-C1-P3-2（2026-09-11 全量重评 GLM-5.3 修复批）回归：useShelf.createBook 的
 * 建书端点调用归置到 api/books.ts 具名函数 createBook——全仓端点调用统一归 api/ 层，
 * 此前本调用是唯一裸 apiJson 漏网。行为零变化（纯归置）：本文件锚定组合式侧的接线
 * （走 api 层具名函数、不再裸调 apiJson）与既有表单语义（成功收表单/刷书架/回调；
 * 失败留错误可重试）；api 函数自身的请求契约见 api-endpoints-a.test.ts 同批用例。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  createBook: vi.fn(),
  apiJson: vi.fn(),
  shelfLoad: vi.fn(async () => {}),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({ createBook: mocks.createBook }))
// 裸调漏网侦测面：若 createBook 退回裸 apiJson（归置回退），下方「apiJson 不被调」断言即红
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  apiJson: mocks.apiJson,
  ApiError: class ApiError extends Error {
    status?: number
    code?: string
  },
}))
vi.mock('../../../src/studio/web-next/src/api/shelf', () => ({ deleteBook: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/stores/shelf', () => ({
  useShelfStore: vi.fn(() => ({ books: [], load: mocks.shelfLoad })),
}))
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: vi.fn(() => ({ shelfView: 'grid', setShelfView: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/stores/chat', () => ({
  useChatStore: vi.fn(() => ({ clearChapterMemo: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({ clearBookMirrors: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/stores/check', () => ({
  clearFalsePositiveMarks: vi.fn(),
  fpBookPrefix: (name: string) => `clw-fp:${name}\u0000`,
}))
vi.mock('../../../src/studio/web-next/src/composables/useChatComposer', () => ({
  clearFailedDrafts: vi.fn(),
  migrateFailedDrafts: vi.fn(),
}))

import { useShelf } from '../../../src/studio/web-next/src/composables/useShelf'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('useShelf.createBook 走 api 层具名函数（R0911-C1-P3-2）', () => {
  it('成功 → 经 api/books.createBook(name, kind) 建书，收表单 + 刷书架 + onCreated；不裸调 apiJson', async () => {
    mocks.createBook.mockResolvedValue({ name: '新书', kind: 'short', path: '/w/新书' })
    const onCreated = vi.fn()
    const s = useShelf({ onCreated })
    s.newName.value = '新书'
    s.newKind.value = 'short'
    await s.createBook()

    // 归置锚点：调用走 api 层具名函数（签名 = 名称 + 形态），裸 apiJson 零命中
    expect(mocks.createBook).toHaveBeenCalledTimes(1)
    expect(mocks.createBook).toHaveBeenCalledWith('新书', 'short')
    expect(mocks.apiJson).not.toHaveBeenCalled()

    // 表单语义零变化：成功收表单（回默认）+ 刷新书架 + 外壳回调带书名
    expect(s.showCreate.value).toBe(false)
    expect(s.newName.value).toBe('')
    expect(s.newKind.value).toBe('long')
    expect(mocks.shelfLoad).toHaveBeenCalledTimes(1)
    expect(onCreated).toHaveBeenCalledWith('新书')
    expect(s.creating.value).toBe(false)
  })

  it('失败 → createError 呈报（friendlyError 链），表单保留可重试，onCreated 不调', async () => {
    mocks.createBook.mockRejectedValueOnce(new Error('书名已存在'))
    const onCreated = vi.fn()
    const s = useShelf({ onCreated })
    s.showCreate.value = true // 建书表单已打开（失败时不得被收起）
    s.newName.value = '重名书'
    await s.createBook()

    expect(s.createError.value).toBeTruthy()
    expect(s.showCreate.value).toBe(true) // 表单保留（重试语义不变）
    expect(s.newName.value).toBe('重名书')
    expect(onCreated).not.toHaveBeenCalled()
    expect(s.creating.value).toBe(false)
  })
})
