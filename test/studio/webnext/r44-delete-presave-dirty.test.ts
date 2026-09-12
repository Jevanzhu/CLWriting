/**
 * R44-3（四十四轮）回归：doDelete 确认前先落盘脏内容。
 *
 * 修复前：确认弹窗「可从回收站恢复」→ deleteDoc → doc.discard——autosave 窗口内的
 * 脏章直接丢弃内存 entry，回收站只有最后已保存版本，文案对脏章失实且新键入无处可寻。
 * 修复后：确认前对 dirty 目标先 doc.save(docId,'manual')（saving 中由 F8 在途链排队
 * 续存）；保存失败/冲突未决换如实文案「未保存的修改将一并丢失（回收站只保留最后已
 * 保存的版本）」。
 *
 * 桩结构对齐 r34d-tree-actions-catch-guard 惯例（documents/client/ui/workspace/tree
 * 全 mock，doc store 走真实 pinia + documents mock）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const treeMock = {
  byPath: new Map<string, { docId: string }>(),
  byDocId: new Map<string, { path: string }>(),
  grouped: [] as unknown[],
  raw: [] as unknown[],
  load: vi.fn(async () => {}),
  updateWordCount: vi.fn(),
}
const askMock = vi.fn(async () => true)
const toastMock = vi.fn()
vi.mock('../../../src/studio/web-next/src/api/documents', () => {
  const getContent = vi.fn(async () => '旧正文')
  return {
    createDoc: vi.fn(),
    renameDoc: vi.fn(),
    moveDoc: vi.fn(),
    copyDoc: vi.fn(),
    deleteDoc: vi.fn(),
    updateChapterMetaDoc: vi.fn(),
    batchFinalizeDocs: vi.fn(),
    getContent,
    // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock(suspect 分支默认不触发)
    getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
    saveContent: vi.fn(),
    finalizeDoc: vi.fn(),
  }
})
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
  useUiStore: vi.fn(() => ({ toast: toastMock, ask: askMock })),
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

import { deleteDoc, saveContent } from '../../../src/studio/web-next/src/api/documents'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const deleteMock = deleteDoc as ReturnType<typeof vi.fn>
const saveMock = saveContent as ReturnType<typeof vi.fn>

let currentBook = '书A'
const openError = ref<string | null>(null)

function node(path: string, docId: string): TreeNode {
  const name = path.split('/').pop()!
  return { path, name, isDirectory: false, role: 'chapter', docId, children: [] } as unknown as TreeNode
}

/** 打开文档并置脏（真实 pinia doc store + documents mock）。 */
async function openDirtyDoc(docId: string): Promise<void> {
  const doc = useDocStore()
  doc.setBook(currentBook)
  await doc.open(node(`写作/正文/${docId}.md`, docId))
  doc.patch(docId, '确认前新键入的段落')
}

function askMessage(): string {
  // ui.ask 单对象入参；askMock 声明形参为空，实参经运行时捕获——经 unknown 中转取 message
  return ((askMock.mock.calls as unknown[][])[0]![0] as { message: string }).message
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  currentBook = '书A'
  deleteMock.mockResolvedValue({ ok: true })
})

describe('R44-3: doDelete 确认前先落盘脏内容', () => {
  it('dirty 章：确认弹窗前先落盘保存成功 → 文案保持「可从回收站恢复」且删除照常', async () => {
    await openDirtyDoc('d1')
    saveMock.mockResolvedValueOnce({ ok: true, revision: 'r', superseded: false })
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    await actions.doDelete(node('写作/正文/d1.md', 'd1'))
    // 修复点：删除链前先把脏内容落盘。R48-88（四十八轮）origin 改 autosave——原
    // manual 会弹「已保存」toast、紧接「确认删除」弹窗语义突兀（内部前置落盘非作者
    // 动作）；autosave 静默落盘，R44-3 防丢语义不变
    expect(saveMock).toHaveBeenCalledTimes(1)
    const [book, docId, payload] = saveMock.mock.calls[0]! as unknown as [
      string,
      string,
      { content: string; origin: string },
    ]
    expect(book).toBe('书A')
    expect(docId).toBe('d1')
    expect(payload.content).toBe('确认前新键入的段落')
    expect(payload.origin).toBe('autosave')
    expect(askMessage()).toContain('可从回收站恢复') // 已落净 → 承诺如实
    expect(deleteMock).toHaveBeenCalledWith('书A', 'd1')
  })

  it('R49-25：save 返 false 但 dirty 已清（F8 排队落盘，内容已在磁盘）→ 不误报「未保存」', async () => {
    await openDirtyDoc('d5')
    // F8 排队时序：在途保存已把全部内容落盘、dirty 已清——此后 manual save 按
    // 「无需重存」返 false（doc.save 对非 dirty 直接短路，不触 saveContent）
    useDocStore().get('d5')!.dirty = false
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    await actions.doDelete(node('写作/正文/d5.md', 'd5'))
    // 修复前：save 返 false 无差别判 unsaved → 误报「未保存的修改将一并丢失」；
    // 修复后（对齐 rewrite R34D-22 口径）：dirty 已清 → 文案保持「可从回收站恢复」
    expect(askMessage()).toContain('可从回收站恢复')
    expect(deleteMock).toHaveBeenCalledWith('书A', 'd5')
  })

  it('dirty 章保存失败 → 换如实文案「未保存的修改将一并丢失」再进删除链', async () => {
    await openDirtyDoc('d2')
    saveMock.mockRejectedValueOnce(new Error('服务开小差'))
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    await actions.doDelete(node('写作/正文/d2.md', 'd2'))
    expect(askMessage()).toContain('未保存的修改将一并丢失')
    expect(askMessage()).toContain('回收站只保留最后已保存的版本')
    expect(deleteMock).toHaveBeenCalledWith('书A', 'd2') // 作者确认后仍执行删除（文案已如实）
  })

  it('dirty 且冲突未决 → 不盲写（零保存请求），直接如实文案', async () => {
    await openDirtyDoc('d3')
    const doc = useDocStore()
    doc.get('d3')!.conflict = true // 冲突未决：自动保存只会再 409
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    await actions.doDelete(node('写作/正文/d3.md', 'd3'))
    expect(saveMock).not.toHaveBeenCalled()
    expect(askMessage()).toContain('未保存的修改将一并丢失')
    expect(deleteMock).toHaveBeenCalledWith('书A', 'd3')
  })

  it('clean 章：不触发预保存（零多余请求），文案与删除照旧', async () => {
    const doc = useDocStore()
    doc.setBook(currentBook) // 不 open/不 patch → 无 entry，非 dirty 形态
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    await actions.doDelete(node('写作/正文/0001-雪.md', 'dx'))
    expect(saveMock).not.toHaveBeenCalled()
    expect(askMessage()).toContain('可从回收站恢复')
    expect(deleteMock).toHaveBeenCalledWith('书A', 'dx')
  })

  it('取消删除（ask 返 false）→ 预保存已完成但删除链不启动', async () => {
    await openDirtyDoc('d4')
    saveMock.mockResolvedValueOnce({ ok: true, revision: 'r', superseded: false })
    askMock.mockResolvedValueOnce(false)
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    await actions.doDelete(node('写作/正文/d4.md', 'd4'))
    expect(saveMock).toHaveBeenCalledTimes(1) // 脏内容已救回（编辑不再依赖删除决定）
    expect(deleteMock).not.toHaveBeenCalled()
  })
})
