// @vitest-environment happy-dom
/**
 * 阶段 24（S3）合并动作流回归——useChapterTreeActions.doMergeIntoPrev。
 *
 * 干跑（structurePlan，:docId = 显示序前一章）→ ui.ask 确认（.cp-modal 动线）→
 * 携干跑指纹执行（structureApply）→ 弃源章 doc 缓存（discard）+ 刷树（tree.load）。
 * 干跑即拦面：encodingSuspect（GBK 存量）不发 apply；ask 拒 false 不发 apply。
 * mock 手法照 chapter-tree-actions-y8-y29.test.ts（api/documents 工厂补
 * structurePlan/structureApply/structureMergeUndo；stores 单例 mock）。
 *
 * 复审-0913-源码 P1：补 doMergeUndo 前置落盘回归（同节 doMergeIntoPrev/doSplitHere
 * 均先 flushUnsaved，undo 原漏——dirty 目标章 undo 后两章内容重复无提示）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import type { MergePlanView, MergeApplyOk } from '../../../src/studio/web-next/src/api/documents'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

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
}))
// store mock 单例（工厂每调返回新对象会让 setup 配置的 spy 与断言侧取到的不是同一个）
const treeMock = {
  grouped: [] as TreeNode[],
  raw: [] as TreeNode[],
  byPath: new Map<string, { docId: string }>(),
  byDocId: new Map<string, { path: string }>(),
  load: vi.fn(async () => {}),
  updateWordCount: vi.fn(),
}
const docMock = {
  // get 返回放宽 unknown：doMergeUndo 前置落盘用例需注入 conflict 脏条目（原恒 undefined）
  get: vi.fn((_id: string): unknown => undefined),
  open: vi.fn(),
  refresh: vi.fn(async () => {}),
  save: vi.fn(async () => true),
  patch: vi.fn(),
  discard: vi.fn(),
  clearDirtyMirror: vi.fn(),
  // doMergeIntoPrev 先 flushUnsaved 两章（落盘脏内容）——mock 补齐防 TypeError
  waitInflightSave: vi.fn(async () => {}),
}
// ui.ask/toast 用文件级共享 mock（y8-y29 工厂内联 vi.fn 每调新对象，断言侧取不到）
const uiAskMock = vi.fn(async () => true)
const uiToastMock = vi.fn()
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: uiToastMock, ask: uiAskMock })),
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

import { structurePlan, structureApply, structureMergeUndo } from '../../../src/studio/web-next/src/api/documents'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'

const planMock = structurePlan as ReturnType<typeof vi.fn>
const applyMock = structureApply as ReturnType<typeof vi.fn>

const mergePlan: MergePlanView = {
  op: 'merge',
  targetDocId: 'doc1',
  sourceDocId: 'doc2',
  targetChapterNo: 1,
  sourceChapterNo: 2,
  targetTitle: '甲',
  sourceTitle: '乙',
  encodingSuspect: false,
  sourceWords: 10,
  sourcePreview: '乙章结尾拼接预览…',
  mergedInto: [2],
  leadPreviews: [],
  ragChunksToClear: 0,
  planHash: 'ph',
}
const applyOk: MergeApplyOk = {
  ok: true,
  targetDocId: 'doc1',
  sourceDocId: 'doc2',
  targetChapterNo: 1,
  sourceChapterNo: 2,
  mergedInto: [2],
  trashEntryId: 'doc2',
  planHash: 'ph',
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  treeMock.grouped = []
  treeMock.raw = []
  treeMock.byPath = new Map()
  treeMock.byDocId = new Map()
})

/** 树夹具：写作 → 正文 → 第一卷 → 0001-甲(doc1) / 0002-乙(doc2)；返回 actions 装配。 */
function setupActions(): {
  actions: ReturnType<typeof useChapterTreeActions>
  openError: Ref<string | null>
  node1: TreeNode
  node2: TreeNode
} {
  const node1: TreeNode = { path: '写作/正文/第一卷/0001-甲.md', name: '0001-甲.md', isDirectory: false, role: 'chapter', children: [], docId: 'doc1', status: 'draft' }
  const node2: TreeNode = { path: '写作/正文/第一卷/0002-乙.md', name: '0002-乙.md', isDirectory: false, role: 'chapter', children: [], docId: 'doc2', status: 'draft' }
  const vol1: TreeNode = { path: '写作/正文/第一卷', name: '第一卷', isDirectory: true, role: '', children: [node1, node2] }
  const bodyRoot: TreeNode = { path: '写作/正文', name: '正文', isDirectory: true, role: '', children: [vol1] }
  const writeRoot: TreeNode = { path: '写作', name: '写作', isDirectory: true, role: '', children: [bodyRoot] }
  treeMock.grouped = [writeRoot]
  treeMock.raw = [writeRoot]
  const openError = ref<string | null>(null)
  const actions = useChapterTreeActions({ bookName: () => '书名', openError })
  return { actions, openError, node1, node2 }
}

describe('doMergeIntoPrev（阶段 24 S3：并入上一章动作流）', () => {
  it('happy path：plan/apply 参数正确（:docId = 前一章 doc1）→ 弃源章缓存 + 刷树', async () => {
    planMock.mockResolvedValue({ plan: { ...mergePlan } })
    applyMock.mockResolvedValue({ ...applyOk })
    uiAskMock.mockResolvedValue(true)
    const { actions, openError, node2 } = setupActions()

    actions.onMenuSelect('merge-into-prev', node2)
    await flushPromises()

    // 干跑：目标 = 显示序前一章（doc1），源 = 右键章（doc2）
    expect(planMock).toHaveBeenCalledWith('书名', 'doc1', { op: 'merge', sourceDocId: 'doc2' })
    expect(uiAskMock).toHaveBeenCalledTimes(1)
    // 执行：携干跑指纹
    expect(applyMock).toHaveBeenCalledWith('书名', 'doc1', { op: 'merge', sourceDocId: 'doc2', planHash: 'ph' })
    // 源章已软删：弃编辑器缓存条目 + 刷树
    expect(docMock.discard).toHaveBeenCalledWith('doc2')
    expect(treeMock.load).toHaveBeenCalledWith('书名')
    expect(openError.value).toBeNull()
  })

  it('encodingSuspect → 干跑即拦：apply 零调用 + openError 置非空（UTF-8 转码提示）', async () => {
    planMock.mockResolvedValue({ plan: { ...mergePlan, encodingSuspect: true } })
    const { actions, openError, node2 } = setupActions()

    actions.onMenuSelect('merge-into-prev', node2)
    await flushPromises()

    expect(applyMock).not.toHaveBeenCalled()
    expect(uiAskMock).not.toHaveBeenCalled() // 确认框都不弹——不让作者确认后才被拒
    expect(openError.value).toContain('UTF-8')
    expect(docMock.discard).not.toHaveBeenCalled()
  })

  it('ui.ask 拒 false → apply 零调用（openError 不置、不动 doc 缓存）', async () => {
    planMock.mockResolvedValue({ plan: { ...mergePlan } })
    uiAskMock.mockResolvedValueOnce(false)
    const { actions, openError, node2 } = setupActions()

    actions.onMenuSelect('merge-into-prev', node2)
    await flushPromises()

    expect(applyMock).not.toHaveBeenCalled()
    expect(openError.value).toBeNull()
    expect(docMock.discard).not.toHaveBeenCalled()
    expect(treeMock.load).not.toHaveBeenCalled()
  })
})

describe('doMergeUndo（复审-0913-P1：undo 前置落盘）', () => {
  it('happy path：先 flushUnsaved（waitInflightSave 首步）后 structureMergeUndo（调用序）', async () => {
    const undoMock = structureMergeUndo as ReturnType<typeof vi.fn>
    undoMock.mockResolvedValue({ ok: true, sourceChapterNo: 2 })
    uiAskMock.mockResolvedValue(true)
    const { actions, node1 } = setupActions()

    actions.onMenuSelect('merge-undo', node1)
    await flushPromises()

    expect(undoMock).toHaveBeenCalledWith('书名', 'doc1')
    // 调用序断言：落盘（flushUnsaved 首步 = waitInflightSave）先于 undo 请求——
    // dirty 目标章不落盘就 undo，refresh 的 dirty 分支会保旧正文，两章内容重复
    expect(docMock.waitInflightSave).toHaveBeenCalledWith('doc1')
    expect(docMock.waitInflightSave.mock.invocationCallOrder[0]).toBeLessThan(
      undoMock.mock.invocationCallOrder[0]!,
    )
    expect(treeMock.load).toHaveBeenCalledWith('书名')
  })

  it('flushUnsaved 失败（conflict 未决）→ 不发 undo + error toast', async () => {
    const undoMock = structureMergeUndo as ReturnType<typeof vi.fn>
    uiAskMock.mockResolvedValue(true)
    // 单次返回 conflict 条目（mockReturnValueOnce：不渗漏到后续用例，beforeEach 只 clear 调用不重置实现）
    docMock.get.mockReturnValueOnce({
      docId: 'doc1',
      path: '写作/正文/第一卷/0001-甲.md',
      content: '',
      dirty: false,
      conflict: true,
    })
    const { actions, node1 } = setupActions()

    actions.onMenuSelect('merge-undo', node1)
    await flushPromises()

    expect(undoMock).not.toHaveBeenCalled()
    expect(uiToastMock).toHaveBeenCalledWith(expect.stringContaining('撤销并入'), 'error')
    expect(treeMock.load).not.toHaveBeenCalled()
  })
})
