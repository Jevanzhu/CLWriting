// @vitest-environment happy-dom
/**
 * 批量定稿失败原因透出（R0916-6-P3-1，评审修复批）回归：
 * 服务端 batch-finalize 逐条返回 error（防吃书闸/LEAD_GATE 人话红项），此前前端只
 * 计数 toast「N 章失败」整段丢弃——作者被闸拦下只能逐章单章定稿排查。修复后
 * failed>0 时 toast 追加首条原因（多项加「等 N 项」），全成功/全 skipped 不带失败段。
 * 装法：真实 store + mock api 层（helpers/real-stores 纪律，P2-5）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'

// ---------- api 边界 mock（兄弟 store 一律真件，见 helpers/real-stores） ----------
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
  getTree: vi.fn(async () => ({ nodes: [], revision: '' })),
  getConfig: vi.fn(async () => ({ kind: 'long' })),
  renameBook: vi.fn(),
}))
// 真 tree store 的 load 红点拉取（fire-and-forget）——不 mock 会对 127.0.0.1:3000 发真 fetch（ECONNREFUSED 噪音）
vi.mock('../../../src/studio/web-next/src/api/tree-issues', () => ({
  getTreeIssues: vi.fn(async () => ({ issues: {} })),
}))

import { batchFinalizeDocs } from '../../../src/studio/web-next/src/api/documents'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'
import { setupRealStores, recordToasts, type RealStores } from './helpers/real-stores'

const batchMock = batchFinalizeDocs as ReturnType<typeof vi.fn>

let stores: RealStores
let toasts: ReturnType<typeof recordToasts>
let currentBook = '书A'

beforeEach(() => {
  vi.clearAllMocks()
  stores = setupRealStores()
  toasts = recordToasts(stores.ui)
  currentBook = '书A'
})

describe('批量定稿 toast 失败原因透出（R0916-6-P3-1）', () => {
  it('部分失败 → toast 追加首条失败原因 + error 级', async () => {
    batchMock.mockResolvedValue({
      ok: true,
      results: [
        { docId: 'd1', ok: true, status: 'final', skipped: false },
        { docId: 'd2', ok: false, error: '该章与前文主角名冲突，疑似吃书，已拦截' },
      ],
    })
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
    await actions.doBatchFinalize(['d1', 'd2'])
    expect(toasts).toHaveBeenCalledTimes(1)
    expect(toasts).toHaveBeenCalledWith(expect.stringContaining('已定稿 1/2 章'), 'error')
    expect(toasts).toHaveBeenCalledWith(
      expect.stringContaining('1 章失败：该章与前文主角名冲突，疑似吃书，已拦截'),
      'error',
    )
    // 失败原因服务端 error 字段直出（防吃书闸人话红项），不再只有干瘪计数
    expect(toasts).toHaveBeenCalledWith(expect.not.stringContaining('原因未知'), 'error')
  })

  it('多项失败 → 首因 + 「等 N 项」', async () => {
    batchMock.mockResolvedValue({
      ok: true,
      results: [
        { docId: 'd1', ok: false, error: 'LEAD_GATE：待定稿章数超主角戏份红线' },
        { docId: 'd2', ok: true, status: 'final', skipped: false },
        { docId: 'd3', ok: false, error: 'revision 缺失' },
      ],
    })
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
    await actions.doBatchFinalize(['d1', 'd2', 'd3'])
    const msg = String(toasts.mock.calls[0]![0])
    expect(msg).toContain('已定稿 1/3 章')
    expect(msg).toContain('2 章失败：LEAD_GATE：待定稿章数超主角戏份红线')
    expect(msg).toContain('（等 2 项）')
    expect(toasts).toHaveBeenCalledWith(msg, 'error')
  })

  it('全成功 / 全 skipped → toast 不带失败段', async () => {
    batchMock.mockResolvedValue({
      ok: true,
      results: [
        { docId: 'd1', ok: true, status: 'final', skipped: true },
        { docId: 'd2', ok: true, status: 'final', skipped: false },
      ],
    })
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
    await actions.doBatchFinalize(['d1', 'd2'])
    const msg = String(toasts.mock.calls[0]![0])
    expect(msg).toContain('已定稿 1/2 章')
    expect(msg).toContain('（1 章已定稿）')
    expect(msg).not.toContain('失败')
    expect(toasts).toHaveBeenCalledWith(msg, 'success')
  })
})
