// @vitest-environment happy-dom
/**
 * R1010b-FE-P3-2（2026-09-10 内存专项重审修复批）回归：改名提交清误报灰显 localStorage 键。
 *
 * 修复前：删除链（E-10）成功后调 clearFalsePositiveMarksForDoc 清 `clw-fp:<书>\u0000<docId>`，
 * 改名链只清 dirty-mirror 不清 fp 键——legacy docId 由路径派生，改名后旧 id 孤儿化，
 * 同路径重建新文档复用同 id 时残留键会把旧章灰显态/禁用误报按钮带给新章。
 * 修复：onRenameCommit 成功后对旧 docId 调同款清理（book 用入口快照）。
 *
 * 键构造走 fpBookPrefix 单源（stores/check.ts 导出，R50-D2-1 口径），防测试侧重拼漂移。
 * 装置对齐 chapter-tree-actions-y8-y29.test.ts（store mock 单例 + 真实 stores/check 的
 * localStorage 扫描逻辑）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// happy-dom localStorage 在 vitest 集成下缺 clear()，提供 Map-backed 替身（r60d3/r51-h4 同款）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
const localStorageMock = createLocalStorage()
vi.stubGlobal('localStorage', localStorageMock)

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  createDoc: vi.fn(),
  renameDoc: vi.fn(),
  moveDoc: vi.fn(),
  copyDoc: vi.fn(),
  deleteDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
  batchFinalizeDocs: vi.fn(),
}))
// store mock 单例（y8-y29 同款：工厂每调返回新对象会让 spy 与断言侧取到的不是同一个）
const treeMock = {
  byPath: new Map<string, { docId: string }>(),
  byDocId: new Map<string, { path: string }>(),
  load: vi.fn(async () => {}),
  updateWordCount: vi.fn(),
}
interface DocEntryLike {
  path: string
  dirty: boolean
}
const docMock = {
  get: vi.fn((_id: string): DocEntryLike | undefined => undefined),
  open: vi.fn(),
  refresh: vi.fn(async () => {}),
  save: vi.fn(async () => true),
  patch: vi.fn(),
  clearDirtyMirror: vi.fn(),
}
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: vi.fn(), ask: vi.fn(async () => true) })),
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => ({ openTab: vi.fn(), activeDocId: ref(null) })),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => treeMock),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => docMock),
}))

import { renameDoc } from '../../../src/studio/web-next/src/api/documents'
import { fpBookPrefix } from '../../../src/studio/web-next/src/stores/check'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'

const renameMock = renameDoc as ReturnType<typeof vi.fn>

let currentBook = '书A'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  currentBook = '书A'
  localStorageMock.clear()
})

function setup(): ReturnType<typeof useChapterTreeActions> {
  docMock.get.mockImplementation((id: string) =>
    id === 'doc_1' ? ({ path: '写作/正文/0001-旧标题.md', dirty: false } as DocEntryLike) : undefined,
  )
  treeMock.byDocId.set('doc_1', { path: '写作/正文/0001-新标题.md' })
  return useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
}

function seedFpKey(docId: string, value: string): string {
  const key = fpBookPrefix('书A') + docId
  localStorageMock.setItem(key, value)
  return key
}

describe('R1010b-FE-P3-2: onRenameCommit 清旧 docId 误报灰显键', () => {
  it('改名成功 → 旧 fp 键清除；docId 兄弟前缀键（doc_10）不受连带', async () => {
    renameMock.mockResolvedValue(undefined)
    const oldKey = seedFpKey('doc_1', '["chk-1"]')
    const siblingKey = seedFpKey('doc_10', '["chk-2"]') // R60-D-3 精确等值口径：doc_10 不得被误删
    const actions = setup()
    treeMock.byPath.set('写作/正文/0001-旧标题.md', { docId: 'doc_1' })
    actions.renamePath.value = '写作/正文/0001-旧标题.md'
    await actions.onRenameCommit('写作/正文/0001-旧标题.md', '新标题')
    expect(localStorageMock.getItem(oldKey)).toBeNull() // 修复前：残留（改名链漏清）
    expect(localStorageMock.getItem(siblingKey)).toBe('["chk-2"]')
  })

  it('改名在途切书：清理用入口快照书名，旧书 fp 键仍被清（不落空）', async () => {
    renameMock.mockImplementation(async () => {
      currentBook = '书B' // 重命名请求在途期间用户切书
    })
    const oldKey = seedFpKey('doc_1', '["chk-1"]')
    const actions = setup()
    treeMock.byPath.set('写作/正文/0001-旧标题.md', { docId: 'doc_1' })
    actions.renamePath.value = '写作/正文/0001-旧标题.md'
    await actions.onRenameCommit('写作/正文/0001-旧标题.md', '新标题')
    expect(localStorageMock.getItem(oldKey)).toBeNull()
  })
})
