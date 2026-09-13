/**
 * R59 清偿批（R55-F-6）回归：doDelete 删除确认预判在「在途保存窗口」不误报。
 *
 * F8 契约：entry.saving 时 doc.save(docId,'autosave') 直接返 false 不等待（节拍自会
 * 重扫），且 dirty 要到保存落定才清——原判式 `!await save && dirty` 在窗口内必误报
 * 「未保存的修改将一并丢失」（内容其实正在落盘）。修复：判式前先 await 在途保存
 * （doc.waitInflightSave，同 flushDirty 的台账等待形态）再按最新 entry 态判定。
 *
 * 桩结构对齐 r44-delete-presave-dirty 惯例（documents/client/ui/workspace/tree 全
 * mock，doc store 走真实 pinia + documents mock）。
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
    getContentPayload: vi.fn(
      async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) }),
    ),
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
  return ((askMock.mock.calls as unknown[][])[0]![0] as { message: string }).message
}

/** 造在途保存：saveContent 挂起到外部放行，返回放行器。 */
function holdSave(): (v?: Error) => void {
  let release!: (v?: Error) => void
  const p = new Promise<{ ok: true; revision: string } | never>((res, rej) => {
    release = (err?: Error) => (err ? rej(err) : res({ ok: true, revision: 'r2' }))
  })
  saveMock.mockImplementationOnce(() => p)
  return release
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  currentBook = '书A'
  deleteMock.mockResolvedValue({ ok: true })
})

describe('R59 清偿批（R55-F-6）: doDelete 在途保存窗口预判', () => {
  it('在途保存落定成功（dirty 清）→ 文案「可从回收站恢复」，不误报未保存', async () => {
    await openDirtyDoc('d9')
    const release = holdSave()
    const doc = useDocStore()
    void doc.save('d9', 'autosave') // 在途保存（挂起）
    expect(doc.get('d9')!.saving).toBe(true)

    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    const deleting = actions.doDelete(node('写作/正文/d9.md', 'd9'))
    for (let i = 0; i < 20; i++) await Promise.resolve() // 泵到「等待在途」处
    release() // 在途保存成功落定 → doSave 清 dirty
    await deleting

    expect(askMessage()).toContain('可从回收站恢复')
    expect(deleteMock).toHaveBeenCalledWith('书A', 'd9')
  })

  it('在途保存落定失败（仍 dirty）→ 如实文案不回退（保守方向保留）', async () => {
    await openDirtyDoc('d8')
    const release = holdSave()
    const doc = useDocStore()
    void doc.save('d8', 'autosave')
    expect(doc.get('d8')!.saving).toBe(true)

    // 落定后调用方的补存请求也失败（saveContent 第二次调用仍挂起会死等——直接再挂一次后放行失败）
    saveMock.mockRejectedValueOnce(new Error('服务开小差'))
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    const deleting = actions.doDelete(node('写作/正文/d8.md', 'd8'))
    for (let i = 0; i < 20; i++) await Promise.resolve()
    release(new Error('服务开小差')) // 在途保存失败落定 → dirty 仍在 → 补存亦失败
    await deleting

    expect(askMessage()).toContain('未保存的修改将一并丢失')
    expect(deleteMock).toHaveBeenCalledWith('书A', 'd8')
  })

  it('无在途保存（常态路径）→ 行为不变，判式照旧', async () => {
    await openDirtyDoc('d7')
    saveMock.mockResolvedValueOnce({ ok: true, revision: 'r', superseded: false })
    const actions = useChapterTreeActions({ bookName: () => currentBook, openError })
    await actions.doDelete(node('写作/正文/d7.md', 'd7'))
    expect(saveMock).toHaveBeenCalledTimes(1) // 判式内的既有 autosave 落盘
    expect(askMessage()).toContain('可从回收站恢复')
    expect(deleteMock).toHaveBeenCalledWith('书A', 'd7')
  })
})
