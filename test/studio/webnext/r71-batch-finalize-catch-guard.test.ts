/**
 * R71-28（七十一轮）回归：doBatchFinalize catch 分支缺书名复检——批量定稿请求失败
 * 时若已切书，A 书的失败 toast 落到 B 书界面（success 分支 R64-2 已有守卫，catch 漏配）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

// ---------- 桩（对齐 r64-switch-guards / chapter-tree-actions-y8-y29 惯例） ----------
const treeMock = {
  byPath: new Map<string, { docId: string }>(),
  byDocId: new Map<string, { path: string }>(),
  load: vi.fn(async () => {}),
  updateWordCount: vi.fn(),
}
const toastMock = vi.fn()
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  createDoc: vi.fn(),
  renameDoc: vi.fn(),
  moveDoc: vi.fn(),
  copyDoc: vi.fn(),
  deleteDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
  batchFinalizeDocs: vi.fn(),
  getContent: vi.fn(async () => '内容'),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => 'test-token'),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: vi.fn(async () => ({ kind: 'long' })),
  renameBook: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: toastMock, ask: vi.fn(async () => true) })),
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => ({ openTab: vi.fn(), activeDocId: ref(null) })),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => treeMock),
}))

import { batchFinalizeDocs } from '../../../src/studio/web-next/src/api/documents'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'

const batchMock = batchFinalizeDocs as ReturnType<typeof vi.fn>

let currentBook = '书A'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  currentBook = '书A'
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
    expect(toastMock).not.toHaveBeenCalled() // 修复点：catch 复检已切书 → 不 toast（修复前弹在 B 书）
  })

  it('失败仍在原书 → error toast（对照组，守卫不误伤）', async () => {
    batchMock.mockRejectedValue(new Error('批量定稿服务异常'))
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
    await actions.doBatchFinalize(['doc_1'])
    expect(toastMock).toHaveBeenCalledTimes(1)
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('批量定稿'), 'error')
  })
})
