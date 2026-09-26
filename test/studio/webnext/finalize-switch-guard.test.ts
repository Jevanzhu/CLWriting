// @vitest-environment happy-dom
/**
 * 批量定稿/单章定稿的切书守卫——按行为合并两散落文件
 * （原 r64-switch-guards R64-2/R64-3 节 + r71-batch-finalize-catch-guard）。
 *
 * - R64-2（十二轮批 A）：doBatchFinalize 批量定稿在途切书 → 不再对新书 tree.load、
 *   toast 不落新书界面（success 分支守卫）。
 * - R71-28（七十一轮）：doBatchFinalize catch 分支补书名复检——批量定稿请求失败时若
 *   已切书，A 书的失败 toast 落到 B 书界面（success 分支 R64-2 已有守卫，catch 漏配）。
 * - R64-3：doc.finalize 定稿在途切书 → 迟到的旧书 load 不再覆盖新书树（返回 true
 *   保持成功语义）。
 *
 * 装法（R0916-6-P2-5 起）：store 全真件（ui/tree/workspace），toast/load 用动作 spy
 * 断言；api 层仍 mock（documents/client/books/tree-issues），纪律见 helpers/real-stores。
 * （R64-31 doc 缓存 LRU 见 doc-lru-evict.test.ts；R64-4 设置组件代守卫见
 * settings-book.test.ts / settings-book-writing.test.ts；R64-32 treeExpanded 复位见
 * workspace-tree-expanded-reset.test.ts。）
 */
import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

// ---------- api 层桩（对齐 chapter-tree-actions-y8-y29 惯例） ----------
const getContent = vi.hoisted(() => vi.fn(async () => '内容'))
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
  getContent,
  // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock(suspect 分支默认不触发)
  getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
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
  getTree: vi.fn(async () => ({ nodes: [], revision: '' })),
  getConfig: vi.fn(async () => ({ kind: 'long' })),
  renameBook: vi.fn(),
}))
// 真 tree store 的 load 红点拉取（fire-and-forget）——不 mock 会对 127.0.0.1:3000 发真 fetch
vi.mock('../../../src/studio/web-next/src/api/tree-issues', () => ({
  getTreeIssues: vi.fn(async () => ({ issues: {} })),
}))

import { batchFinalizeDocs, finalizeDoc } from '../../../src/studio/web-next/src/api/documents'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'
import { setupRealStores, recordToasts, type RealStores } from './helpers/real-stores'

const batchMock = batchFinalizeDocs as ReturnType<typeof vi.fn>
const finalizeMock = finalizeDoc as ReturnType<typeof vi.fn>

let stores: RealStores
let toasts: ReturnType<typeof recordToasts>
let treeLoad: MockInstance
let currentBook = '书A'

beforeEach(() => {
  vi.clearAllMocks()
  currentBook = '书A'
  // 真 store：toast/load 用动作 spy 录制（R0916-6-P2-5 装法，替代整 store mock）
  stores = setupRealStores()
  toasts = recordToasts(stores.ui)
  treeLoad = vi.spyOn(stores.tree, 'load')
})

describe('R64-2: doBatchFinalize 在途切书不刷新书树', () => {
  it('批量定稿在途切书 → tree.load(旧书) 不调用、toast 不落新书界面', async () => {
    let resolveBatch!: (r: unknown) => void
    batchMock.mockImplementation(
      () =>
        new Promise((r) => {
          resolveBatch = r
        }),
    )
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
    const p = actions.doBatchFinalize(['doc_1'])
    await flushPromises()
    currentBook = '书B' // 在途切书
    resolveBatch({ results: [{ ok: true, skipped: false }] })
    await p
    await flushPromises()
    // 修复前：迟到的 load(书A) 后发后至覆盖 B 书树 + toast 落 B 书界面
    expect(treeLoad).not.toHaveBeenCalled()
    expect(toasts).not.toHaveBeenCalled()
  })

  it('未切书（对照）→ 正常 toast + load(书A)', async () => {
    batchMock.mockResolvedValue({ results: [{ ok: true, skipped: false }] })
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
    await actions.doBatchFinalize(['doc_1'])
    expect(treeLoad).toHaveBeenCalledWith('书A', true)
    expect(toasts).toHaveBeenCalled()
  })
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

describe('R64-3: doc.finalize 在途切书不刷新书树', () => {
  it('定稿在途切书 → 不 load 旧书、不 toast（返回 true 保持成功语义）', async () => {
    // 真 doc store（R0916-6-P2-5 起 store 全真件，不再动态 import 绕 mock）
    const doc = stores.doc
    doc.setBook('书A')
    let resolveFin!: (r: unknown) => void
    finalizeMock.mockImplementation(
      () =>
        new Promise((r) => {
          resolveFin = r
        }),
    )
    const p = doc.finalize('d1')
    await flushPromises()
    doc.setBook('书B') // 在途切书
    resolveFin({ ok: true })
    expect(await p).toBe(true)
    await flushPromises()
    expect(treeLoad).not.toHaveBeenCalled()
    expect(toasts).not.toHaveBeenCalled()
  })
})
