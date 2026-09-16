/**
 * R71-28（七十一轮）回归：doBatchFinalize catch 分支缺书名复检——批量定稿请求失败
 * 时若已切书，A 书的失败 toast 落到 B 书界面（success 分支 R64-2 已有守卫，catch 漏配）。
 * 装法（R0916-6-P2-5 起）：store 全真件（ui/tree/workspace），toast 用动作 spy 断言；
 * api 层仍 mock（documents/client/books），纪律见 helpers/real-stores。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

// ---------- api 层桩（对齐 r64-switch-guards / chapter-tree-actions-y8-y29 惯例） ----------
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  createDoc: vi.fn(),
  renameDoc: vi.fn(),
  moveDoc: vi.fn(),
  copyDoc: vi.fn(),
  deleteDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
  batchFinalizeDocs: vi.fn(),
  structurePlan: vi.fn(),
  structureApply: vi.fn(),
  structureMergeUndo: vi.fn(),
  getContent: vi.fn(async () => '内容'),
  getContentPayload: vi.fn(async () => ({ content: '内容' })),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
}))
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: vi.fn(async () => ({ kind: 'long' })),
  renameBook: vi.fn(),
}))

import { batchFinalizeDocs } from '../../../src/studio/web-next/src/api/documents'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'
import { setupRealStores, recordToasts } from './helpers/real-stores'

const batchMock = batchFinalizeDocs as ReturnType<typeof vi.fn>

let toasts: ReturnType<typeof recordToasts>
let currentBook = '书A'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  currentBook = '书A'
  toasts = recordToasts(setupRealStores().ui)
})

describe('R71-28: doBatchFinalize catch 补切书复检', () => {
  it('批量定稿失败 + 在途切书 → 失败 toast 不落 B 书界面', async () => {
    let rejectBatch!: (e: Error) => void
    batchMock.mockImplementation(
      () =>
        new Promise((_res, rej) => {
          rejectBatch = rej
        }),
    )
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
    const p = actions.doBatchFinalize(['doc_1'])
    await flushPromises()
    currentBook = '书B' // 在途切书
    rejectBatch(new Error('批量定稿服务异常'))
    await p
    await flushPromises()
    expect(toasts).not.toHaveBeenCalled() // 修复点：catch 复检已切书 → 不 toast（修复前弹在 B 书）
  })

  it('失败仍在原书 → error toast（对照组，守卫不误伤）', async () => {
    batchMock.mockRejectedValue(new Error('批量定稿服务异常'))
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
    await actions.doBatchFinalize(['doc_1'])
    expect(toasts).toHaveBeenCalledTimes(1)
    expect(toasts).toHaveBeenCalledWith(expect.stringContaining('批量定稿'), 'error')
  })
})
