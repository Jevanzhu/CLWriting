// @vitest-environment happy-dom
/**
 * Y-8 / Y-29（第五十七轮）回归——树操作后 doc 缓存对齐。
 *
 * Y-8：onSaveMeta（树右键「章节信息」）保存成功后对打开中的文档补 doc.refresh——
 * 服务端 op=meta 写 fm + rename 后 revision 已变，不重对齐基线则该文档下一次
 * autosave/⌘S 必收 REVISION_CONFLICT（自造冲突，作者被迫二选一丢数据）。
 * Y-29：onRenameCommit / doMove 成功后回填 doc entry.path——不回填则后续
 * doc.refresh 按旧路径 404 被静默吞、树字数更新成 no-op。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  createDoc: vi.fn(),
  renameDoc: vi.fn(),
  moveDoc: vi.fn(),
  copyDoc: vi.fn(),
  deleteDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
  batchFinalizeDocs: vi.fn(),
}))
// store mock 单例（工厂每调返回新对象会让 setup 配置的 spy 与断言侧取到的不是同一个）
const treeMock = {
  byPath: new Map<string, { docId: string }>(),
  byDocId: new Map<string, { path: string }>(),
  load: vi.fn(async () => {}),
  updateWordCount: vi.fn(),
}
interface DocEntryLike { path: string; dirty: boolean }
const docMock = {
  get: vi.fn((_id: string): DocEntryLike | undefined => undefined),
  open: vi.fn(),
  refresh: vi.fn(async () => {}),
  save: vi.fn(async () => true),
  patch: vi.fn(),
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

import { updateChapterMetaDoc, renameDoc, moveDoc } from '../../../src/studio/web-next/src/api/documents'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'

const metaMock = updateChapterMetaDoc as ReturnType<typeof vi.fn>
const renameMock = renameDoc as ReturnType<typeof vi.fn>
const moveMock = moveDoc as ReturnType<typeof vi.fn>

let currentBook = '书A'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  currentBook = '书A'
})

function setup(openDoc?: { path: string }): ReturnType<typeof useChapterTreeActions> {
  const e = openDoc ? ({ path: openDoc.path, dirty: false } as { path: string; dirty: boolean } | undefined) : (undefined as unknown as { path: string; dirty: boolean } | undefined)
  docMock.get.mockImplementation((id: string) => (id === 'doc_1' ? e : undefined))
  treeMock.byDocId.set('doc_1', { path: '写作/正文/第一卷/0005-新标题.md' })
  return useChapterTreeActions({ bookName: () => currentBook, openError: ref(null) })
}

describe('Y-8: onSaveMeta 后 refresh 打开中文档', () => {
  it('文档打开中 → meta 保存成功后调用 doc.refresh（对齐基线）并回填 path', async () => {
    metaMock.mockResolvedValue(undefined)
    const actions = setup({ path: '写作/正文/第一卷/0005-旧标题.md' })
    actions.metaEditing.value = { docId: 'doc_1', bookName: '书A', 标题: '旧标题', num: 5, isPiece: false }
    await actions.onSaveMeta({ 标题: '新标题', num: 5 })
    expect(docMock.refresh).toHaveBeenCalledWith('doc_1')
    expect((docMock.get('doc_1') as { path: string }).path).toBe('写作/正文/第一卷/0005-新标题.md')
  })

  it('文档未打开 → 不 refresh（无基线可对齐）', async () => {
    metaMock.mockResolvedValue(undefined)
    const actions = setup() // doc.get → undefined
    actions.metaEditing.value = { docId: 'doc_1', bookName: '书A', 标题: '旧', num: 5, isPiece: false }
    await actions.onSaveMeta({ 标题: '新', num: 5 })
    expect(docMock.refresh).not.toHaveBeenCalled()
  })
})

describe('Y-29: rename / move 后回填 entry.path', () => {
  it('onRenameCommit → doc entry.path 更新为新路径', async () => {
    renameMock.mockResolvedValue(undefined)
    const actions = setup({ path: '写作/正文/第一卷/0005-旧标题.md' })
    treeMock.byPath.set('写作/正文/第一卷/0005-旧标题.md', { docId: 'doc_1' })
    actions.renamePath.value = '写作/正文/第一卷/0005-旧标题.md'
    await actions.onRenameCommit('写作/正文/第一卷/0005-旧标题.md', '新标题')
    expect((docMock.get('doc_1') as { path: string }).path).toBe('写作/正文/第一卷/0005-新标题.md')
  })

  it('doMove → doc entry.path 更新为目标路径', async () => {
    moveMock.mockResolvedValue(undefined)
    const actions = setup({ path: '写作/正文/第一卷/0005-标题.md' })
    await actions.doMove('doc_1', '写作/正文/第二卷')
    expect((docMock.get('doc_1') as { path: string }).path).toBe('写作/正文/第一卷/0005-新标题.md')
  })
})

describe('B-10: rename / move 在途切书守卫（await 后活源复检，对齐 doDelete/doCopy）', () => {
  it('onRenameCommit 在途切书 → 不再 tree.load(旧书)，旧书树不覆盖新书树', async () => {
    renameMock.mockImplementation(async () => {
      currentBook = '书B' // 重命名请求在途期间用户切书
    })
    const actions = setup({ path: '写作/正文/第一卷/0005-旧标题.md' })
    treeMock.byPath.set('写作/正文/第一卷/0005-旧标题.md', { docId: 'doc_1' })
    actions.renamePath.value = '写作/正文/第一卷/0005-旧标题.md'
    await actions.onRenameCommit('写作/正文/第一卷/0005-旧标题.md', '新标题')
    expect(treeMock.load).not.toHaveBeenCalledWith('书A')
    // 回填也跳过（树已切到 B 书，byDocId 命中的是 B 书数据）
    expect((docMock.get('doc_1') as { path: string }).path).toBe('写作/正文/第一卷/0005-旧标题.md')
  })

  it('doMove 在途切书 → 不再 tree.load(旧书)', async () => {
    moveMock.mockImplementation(async () => {
      currentBook = '书B'
    })
    const actions = setup({ path: '写作/正文/第一卷/0005-标题.md' })
    await actions.doMove('doc_1', '写作/正文/第二卷')
    expect(treeMock.load).not.toHaveBeenCalled()
  })

  it('未切书 → 正常 tree.load（守卫不误伤）', async () => {
    renameMock.mockResolvedValue(undefined)
    const actions = setup({ path: '写作/正文/第一卷/0005-旧标题.md' })
    treeMock.byPath.set('写作/正文/第一卷/0005-旧标题.md', { docId: 'doc_1' })
    actions.renamePath.value = '写作/正文/第一卷/0005-旧标题.md'
    await actions.onRenameCommit('写作/正文/第一卷/0005-旧标题.md', '新标题')
    expect(treeMock.load).toHaveBeenCalledWith('书A')
  })
})
