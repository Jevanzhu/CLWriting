/**
 * R34D-21（三十四轮）回归：useChapterTreeActions 七个动作 catch 缺切书守卫——
 * A 书请求失败落 catch 时若已切书，A 书报错写进 B 书界面（openError 常驻顶栏）。
 * 仅 doBatchFinalize 有 R71-28 先例；本批对齐补齐 onSaveMeta / createSingleton /
 * onCreateCommit / onRenameCommit / doDelete / doMove / doCopy 七处。
 *
 * R34D-26（三十四轮）回归：正文文件名补零三口径统一到 chapterFilePrefix 单源
 * （M-4 权威口径：长篇 4 位 / 短篇 3 位）——doCopy 按被复制文件宽度推 kind（原硬编码
 * 'chapter'，短篇书副本也 4 位）、新建种子与卷内首章补零（原完全不补零）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

// ---------- 桩（对齐 r71-batch-finalize-catch-guard / chapter-tree-actions-y8-y29 惯例） ----------
const treeMock = {
  byPath: new Map<string, { docId: string }>(),
  byDocId: new Map<string, { path: string }>(),
  grouped: [] as unknown[],
  raw: [] as unknown[],
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
  useWorkspaceStore: vi.fn(() => ({
    openTab: vi.fn(),
    activeDocId: ref(null),
    treeExpanded: [] as string[],
    setTreeExpanded: vi.fn(),
  })),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => treeMock),
}))

import { createDoc, renameDoc, moveDoc, copyDoc, deleteDoc, updateChapterMetaDoc } from '../../../src/studio/web-next/src/api/documents'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const createMock = createDoc as ReturnType<typeof vi.fn>
const renameMock = renameDoc as ReturnType<typeof vi.fn>
const moveMock = moveDoc as ReturnType<typeof vi.fn>
const copyMock = copyDoc as ReturnType<typeof vi.fn>
const deleteMock = deleteDoc as ReturnType<typeof vi.fn>
const metaMock = updateChapterMetaDoc as ReturnType<typeof vi.fn>

let currentBook = '书A'
let openError = ref<string | null>(null)

/** 造一个正文文件树节点（pad 形态由文件名自带） */
function bodyFile(path: string): TreeNode {
  const name = path.split('/').pop()!
  return { path, name, isDirectory: false, role: 'chapter', docId: `d_${name}`, children: [] } as unknown as TreeNode
}

/** 挂起一个 api mock：返回 [promise 句柄]，reject 后经切书守卫落 catch */
function hang(mock: ReturnType<typeof vi.fn>): { reject: (e: Error) => void } {
  let rej!: (e: Error) => void
  mock.mockImplementationOnce(() => new Promise((_r, reject) => (rej = reject)))
  return { reject: (e) => rej(e) }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  currentBook = '书A'
  openError = ref<string | null>(null)
  treeMock.byPath = new Map()
  treeMock.byDocId = new Map()
  treeMock.grouped = []
  treeMock.raw = []
})

describe('R34D-21: 七动作 catch 补切书守卫（A 书报错不落 B 书界面）', () => {
  async function runCase(
    trigger: (a: ReturnType<typeof useChapterTreeActions>) => Promise<unknown>,
    mock: ReturnType<typeof vi.fn>,
  ): Promise<void> {
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    const h = hang(mock)
    const p = trigger(actions)
    await flushPromises()
    currentBook = '书B' // 在途切书
    h.reject(new Error('服务开小差'))
    await p
    await flushPromises()
    expect(openError.value).toBeNull() // 修复点：catch 复检已切书 → 不写 B 书 openError
  }

  it('doCopy：复制失败 + 切书 → openError 不落 B 书', async () => {
    await runCase((a) => a.doCopy(bodyFile('写作/正文/0001-雪.md')), copyMock)
  })
  it('doDelete：删除失败 + 切书 → openError 不落 B 书', async () => {
    await runCase((a) => a.doDelete(bodyFile('写作/正文/0001-雪.md')), deleteMock)
  })
  it('doMove：移动失败 + 切书 → openError 不落 B 书', async () => {
    await runCase((a) => a.doMove('d1', '写作/正文/卷一'), moveMock)
  })
  it('onRenameCommit：重命名失败 + 切书 → openError 不落 B 书', async () => {
    await runCase((a) => {
      const path = '写作/正文/0001-雪.md'
      a.renamePath.value = path
      treeMock.byPath.set(path, { docId: 'd1' })
      return a.onRenameCommit(path, '0001-雪国')
    }, renameMock)
  })
  it('onCreateCommit：新建失败 + 切书 → openError 不落 B 书', async () => {
    await runCase((a) => {
      a.creating.value = { kind: 'chapter', renderDir: '写作', fsDir: '写作/正文', seed: '0002-未命名' }
      return a.onCreateCommit('0002-风起')
    }, createMock)
  })
  it('createSingleton：单例新建失败 + 切书 → openError 不落 B 书', async () => {
    await runCase((a) => a.createSingleton('大纲/总纲.md', '总纲'), createMock)
  })
  it('onSaveMeta：篇章信息保存失败 + 切书 → openError 不落 B 书', async () => {
    await runCase((a) => {
      a.metaEditing.value = { docId: 'd1', 标题: '旧题', num: 1, isPiece: false, bookName: '书A' }
      return a.onSaveMeta({ 标题: '新题', num: 2 })
    }, metaMock)
  })

  it('对照组：未切书的失败照常落 openError（守卫不误伤）', async () => {
    copyMock.mockRejectedValue(new Error('服务开小差'))
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    await actions.doCopy(bodyFile('写作/正文/0001-雪.md'))
    expect(openError.value).toContain('服务开小差')
  })
})

describe('R34D-26: 补零口径统一 chapterFilePrefix 单源（长篇 4 位 / 短篇 3 位）', () => {
  it('doCopy 长篇书：源文件 4 位 → 副本 4 位（既有行为回归）', async () => {
    const src = bodyFile('写作/正文/0002-雪.md')
    treeMock.grouped = [src]
    copyMock.mockResolvedValue({ ok: true, path: '写作/正文/0003-雪 副本.md' })
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    await actions.doCopy(src)
    expect(copyMock).toHaveBeenCalledWith('书A', 'd_0002-雪.md', '写作/正文/0003-雪 副本.md')
  })

  it('doCopy 短篇书：源文件 3 位 → 副本 3 位（修复前硬编码 4 位）', async () => {
    const src = bodyFile('写作/正文/004-桥.md')
    treeMock.grouped = [src]
    copyMock.mockResolvedValue({ ok: true, path: '写作/正文/005-桥 副本.md' })
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    await actions.doCopy(src)
    // 修复点：短篇书副本按 3 位补零（修复前 0005-桥 副本.md）
    expect(copyMock).toHaveBeenCalledWith('书A', 'd_004-桥.md', '写作/正文/005-桥 副本.md')
  })

  it('startCreate 章节种子按本书口径补零（修复前 3-未命名 完全不补零）', async () => {
    treeMock.grouped = [
      { path: '写作', name: '写作', isDirectory: true, role: 'dir', docId: null, children: [bodyFile('写作/正文/0002-雪.md')] },
    ]
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    actions.startCreate('chapter', '写作', '写作/正文')
    expect(actions.creating.value?.seed).toBe('0003-未命名') // 修复点：4 位补零
  })

  it('onCreateCommit 建卷首章文件名补零走单源（修复前 3-未命名.md 不补零）', async () => {
    treeMock.grouped = [bodyFile('写作/正文/0002-雪.md')]
    createMock.mockResolvedValue({ ok: true, path: '写作/正文/0003-未命名.md' })
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    actions.creating.value = { kind: 'volume', renderDir: '写作', fsDir: '写作/正文', seed: '' }
    await actions.onCreateCommit('第一卷')
    const relPath = createMock.mock.calls[0]![1] as { relPath: string }
    // 修复点：卷内首章补零 0003-（修复前 3-未命名.md 不补零）+ 卷名目录段保持 HEAD
    // 既有行为（`正文/${卷名}/${章文件}`——主评审核销 E1 初稿误删 ${name}/ 段：e2e
    // tree-ops「建卷 → 移动章到卷」实证丢段后首章落正文根、卷节点永不出现）
    expect(relPath.relPath).toBe('写作/正文/第一卷/0003-未命名.md')
  })

  it('空书（无正文文件）→ 回落长篇 4 位（维持 M-4 既有行为）', async () => {
    const src = bodyFile('写作/正文/12-手建章.md') // legacy 无补零，树中也无其他口径
    treeMock.grouped = [src]
    copyMock.mockResolvedValue({ ok: true, path: '写作/正文/0013-手建章 副本.md' })
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    await actions.doCopy(src)
    expect(copyMock).toHaveBeenCalledWith('书A', 'd_12-手建章.md', '写作/正文/0013-手建章 副本.md')
  })
})
