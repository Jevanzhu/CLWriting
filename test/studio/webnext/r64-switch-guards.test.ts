// @vitest-environment happy-dom
/**
 * R64（十二轮）批 A 回归——tree.load 调用方切书守卫 + doc 缓存 LRU。
 *
 * R64-2：doBatchFinalize 批量定稿在途切书 → 不再对新书 tree.load、toast 不落新书界面。
 * R64-3：doc.finalize 定稿在途切书 → 迟到的旧书 load 不再覆盖新书树。
 * R64-31：doc 缓存命中重排——evictLRU 真 LRU（交替使用的文档不被误驱逐）。
 * （R64-4 设置组件代守卫见 settings-book.test.ts / settings-book-writing.test.ts；
 *   R64-32 treeExpanded 复位见 prefs-store.test.ts。）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

// ---------- R64-2：useChapterTreeActions 桩（对齐 chapter-tree-actions-y8-y29 惯例） ----------
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

import { batchFinalizeDocs, finalizeDoc, getContent } from '../../../src/studio/web-next/src/api/documents'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'

const batchMock = batchFinalizeDocs as ReturnType<typeof vi.fn>
const finalizeMock = finalizeDoc as ReturnType<typeof vi.fn>

let currentBook = '书A'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  currentBook = '书A'
})

describe('R64-2: doBatchFinalize 在途切书不刷新书树', () => {
  it('批量定稿在途切书 → tree.load(旧书) 不调用、toast 不落新书界面', async () => {
    let resolveBatch!: (r: unknown) => void
    batchMock.mockImplementation(
      () => new Promise((r) => {
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
    expect(treeMock.load).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('未切书（对照）→ 正常 toast + load(书A)', async () => {
    batchMock.mockResolvedValue({ results: [{ ok: true, skipped: false }] })
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
    await actions.doBatchFinalize(['doc_1'])
    expect(treeMock.load).toHaveBeenCalledWith('书A', true)
    expect(toastMock).toHaveBeenCalled()
  })
})

describe('R64-3: doc.finalize 在途切书不刷新书树', () => {
  it('定稿在途切书 → 不 load 旧书、不 toast（返回 true 保持成功语义）', async () => {
    // 真 doc store：mock stores 已在上面统一替换（tree/ui 均 mock）
    const { useDocStore } = await import('../../../src/studio/web-next/src/stores/doc')
    const doc = useDocStore()
    doc.setBook('书A')
    let resolveFin!: (r: unknown) => void
    finalizeMock.mockImplementation(
      () => new Promise((r) => {
        resolveFin = r
      }),
    )
    const p = doc.finalize('d1')
    await flushPromises()
    doc.setBook('书B') // 在途切书
    resolveFin({ ok: true })
    expect(await p).toBe(true)
    await flushPromises()
    expect(treeMock.load).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
  })
})

describe('R64-31: doc 缓存命中重排（evictLRU 真 LRU）', () => {
  it('重开在缓存中的文档 → 移到最新位；后续驱逐淘汰的是真实最久未用', async () => {
    const { useDocStore } = await import('../../../src/studio/web-next/src/stores/doc')
    const doc = useDocStore()
    doc.setBook('test-book')
    vi.mocked(getContent).mockResolvedValue('内容')
    const node = (id: string) =>
      ({
        path: `写作/正文/${id}.md`,
        name: `${id}.md`,
        isDirectory: false,
        role: 'chapter',
        docId: id,
        children: [],
      }) as never
    for (const id of Array.from({ length: 22 }, (_, i) => `d${i + 1}`)) await doc.open(node(id))
    expect(doc.docs.size).toBe(20)
    expect(doc.get('d1')).toBeUndefined() // 插入序最旧两个出局
    // 重开 d3（命中重排）→ 再开 d23：应驱逐 d4（真实最久未用），d3 存活
    await doc.open(node('d3'))
    await doc.open(node('d23'))
    expect(doc.get('d3')).toBeDefined()
    expect(doc.get('d4')).toBeUndefined()
    expect(doc.docs.size).toBe(20)
  })
})
