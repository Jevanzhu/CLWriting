// @vitest-environment happy-dom
/**
 * 批量定稿的防吃书闸降级提示（源码锚 src/studio/web-next/src/composables/useChapterTreeActions.ts
 * doBatchFinalize；回包字段 src/studio/web-next/src/api/documents.ts BatchFinalizeItem.gateDegraded）。
 *
 * 修复前：批量路径只读 ok/skipped/error，服务端随逐项透出的 gateDegraded（闸门 fail-open
 * 放行：账本推进文件读失败或闸自身异常）被整段丢弃——降级放行与正常定稿同报绿色成功，
 * 作者不知道这些章没过闭合比对、需要补检。单章路径靠强转读到了，批量没有。
 * 修复后：字段进共享回包类型；有降级章时 toast 改 warning，点明章数与首条原因。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

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
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return { ...actual, getToken: vi.fn(() => 'test-token') }
})
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getTree: vi.fn(async () => ({ nodes: [], revision: '' })),
  getConfig: vi.fn(async () => ({ kind: 'long' })),
  renameBook: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/tree-issues', () => ({
  getTreeIssues: vi.fn(async () => ({ issues: {} })),
}))

import { batchFinalizeDocs } from '../../../src/studio/web-next/src/api/documents'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'
import { setupRealStores, recordToasts } from './helpers/real-stores'

const batchMock = batchFinalizeDocs as ReturnType<typeof vi.fn>

let toasts: ReturnType<typeof recordToasts>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  const stores = setupRealStores()
  toasts = recordToasts(stores.ui)
})

describe('批量定稿透出防吃书闸降级', () => {
  it('有降级放行的章 → warning toast，点明章数与首条原因（不再报绿色成功）', async () => {
    batchMock.mockResolvedValue({
      results: [
        { docId: 'd1', ok: true, skipped: false, gateDegraded: ['账本推进文件读取失败'] },
        { docId: 'd2', ok: true, skipped: false, gateDegraded: ['防吃书闸异常'] },
        { docId: 'd3', ok: true, skipped: false },
      ],
    })
    const actions = useChapterTreeActions({ bookName: () => '书A', openError: ref(null) })
    await actions.doBatchFinalize(['d1', 'd2', 'd3'])
    expect(toasts).toHaveBeenCalledWith(expect.stringContaining('已定稿 3/3 章'), 'warning')
    const text = toasts.mock.calls.at(-1)?.[0] as string
    expect(text).toContain('其中 2 章防吃书检查降级已放行')
    expect(text).toContain('账本推进文件读取失败')
    expect(text).toContain('等 2 章')
  })

  it('全部正常定稿（无降级）→ 仍是 success toast', async () => {
    batchMock.mockResolvedValue({ results: [{ docId: 'd1', ok: true, skipped: false }] })
    const actions = useChapterTreeActions({ bookName: () => '书A', openError: ref(null) })
    await actions.doBatchFinalize(['d1'])
    expect(toasts).toHaveBeenCalledWith(expect.stringContaining('已定稿 1/1 章'), 'success')
  })

  it('有失败项时失败优先：error toast，降级说明仍附在文案里', async () => {
    batchMock.mockResolvedValue({
      results: [
        { docId: 'd1', ok: false, error: '账本未闭合' },
        { docId: 'd2', ok: true, skipped: false, gateDegraded: ['防吃书闸异常'] },
      ],
    })
    const actions = useChapterTreeActions({ bookName: () => '书A', openError: ref(null) })
    await actions.doBatchFinalize(['d1', 'd2'])
    expect(toasts).toHaveBeenCalledWith(expect.stringContaining('1 章失败：账本未闭合'), 'error')
    expect(toasts.mock.calls.at(-1)?.[0]).toContain('防吃书检查降级已放行')
  })
})
