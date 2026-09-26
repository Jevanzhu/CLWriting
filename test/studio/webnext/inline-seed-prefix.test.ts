// @vitest-environment happy-dom
/**
 * 拍板快断批（2026-09-15，作者指令「按建议顺序开工」取前端拼回档）回归——
 * inline 新建 seed 章号前缀拼回（阶段 24 批 B 登记项）。
 *
 * 修复前：作者清掉种子前缀只填标题 → 文件名无章号落盘，nextChapterNo 取号扫描
 * 与读侧 parseChapterFileName 双失明（连建多章 fm 章号重号、跨卷重号章被结构
 * 合并 400 拒收）。修复后：提交侧对无章号形态拼回 seedPrefix；作者自填章号
 * 形态（「0007-…」/「第7章…」）不覆盖。
 *
 * harness 复制 chapter-tree-actions-y8-y29（mock 单例 + pinia），startCreate 路径
 * 额外补 ws.treeExpanded/setTreeExpanded 与 tree.grouped 树桩（TreeNode 形态，
 * 0005-第五章 → nextChapterNo = 6、bodyPadKind = chapter 4 位补零）。
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
  grouped: [] as import('../../../src/studio/web-next/src/types/tree').TreeNode[],
}
const docMock = {
  get: vi.fn((_id: string) => undefined),
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
  useWorkspaceStore: vi.fn(() => ({
    openTab: vi.fn(),
    activeDocId: ref(null),
    setTreeExpanded: vi.fn(),
    treeExpanded: [] as string[],
  })),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => treeMock),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => docMock),
}))
vi.mock('../../../src/studio/web-next/src/stores/check', () => ({
  clearFalsePositiveMarksForDoc: vi.fn(),
}))

import { createDoc } from '../../../src/studio/web-next/src/api/documents'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'

const createMock = createDoc as ReturnType<typeof vi.fn>

function node(p: string, name: string, dir: boolean, children: TreeNode[] = []): TreeNode {
  return { path: p, name, isDirectory: dir, role: dir ? 'group' : 'chapter', children }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  treeMock.byPath.clear()
  treeMock.byDocId.clear()
  // 一章在树（0005-第五章）→ nextChapterNo = 6、bodyPadKind = chapter（4 位补零）
  treeMock.grouped = [
    node('写作', '写作', true, [
      node('写作/正文', '正文', true, [node('写作/正文/0005-第五章.md', '0005-第五章.md', false)]),
    ]),
    node('大纲', '大纲', true, [node('大纲/章纲', '章纲', true)]),
  ]
  createMock.mockResolvedValue({ path: '写作/正文/0006-夜行.md' })
})

describe('拍板快断批 2026-09-15: inline 新建 seed 前缀拼回', () => {
  it('作者清掉前缀只填标题 → 提交侧拼回 seedPrefix（0006-）', async () => {
    const actions = useChapterTreeActions({ bookName: () => '书A', openError: ref(null) })
    actions.onNewChapter()
    expect(actions.creating.value?.seedPrefix).toBe('0006-')
    await actions.onCreateCommit('夜行')
    expect(createMock).toHaveBeenCalledWith('书A', expect.objectContaining({ relPath: '写作/正文/0006-夜行.md' }))
  })

  it('作者自填章号形态（数字前缀 / 第N章）→ 不覆盖不双拼', async () => {
    const actions = useChapterTreeActions({ bookName: () => '书A', openError: ref(null) })
    actions.onNewChapter()
    await actions.onCreateCommit('0009-终章')
    expect(createMock).toHaveBeenCalledWith('书A', expect.objectContaining({ relPath: '写作/正文/0009-终章.md' }))
    actions.onNewChapter()
    await actions.onCreateCommit('第7章-重逢')
    expect(createMock).toHaveBeenCalledWith('书A', expect.objectContaining({ relPath: '写作/正文/第7章-重逢.md' }))
  })

  it('章纲（chapter-outline）同款拼回 → 大纲/章纲/0006-铺垫.md', async () => {
    const actions = useChapterTreeActions({ bookName: () => '书A', openError: ref(null) })
    actions.startCreate('chapter-outline', '大纲', '大纲/章纲')
    expect(actions.creating.value?.seedPrefix).toBe('0006-')
    await actions.onCreateCommit('铺垫')
    expect(createMock).toHaveBeenCalledWith('书A', expect.objectContaining({ relPath: '大纲/章纲/0006-铺垫.md' }))
  })
})
