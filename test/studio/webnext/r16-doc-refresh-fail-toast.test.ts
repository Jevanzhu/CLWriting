/**
 * 重审-16（2026-09-07 全量代码重审 §四.16）回归：refresh / syncCleanWithTree 失败的
 * UI 面。
 *
 * 缺陷：「fm 以服务端为准」的两条关键对齐路径（refresh——MetaFormPanel 保存后回拉、
 * syncCleanWithTree——树刷新后 clean 缓存对账）失败时静默返 false / 吞错，UI 无任何
 * 面——作者对着过期 fm/正文继续操作毫无感知。修复：失败处 toast warning
 * 「文档信息刷新失败，显示内容可能已过期」（同文案 + 同 kind 经 ui.toast 的合并机制
 * 天然防刷屏；返回值语义不变）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const toastSpy = vi.fn()

vi.mock('../../../src/studio/web-next/src/api/documents', () => {
  const getContent = vi.fn()
  return {
    getContent,
    // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock(suspect 分支默认不触发)
    getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
    saveContent: vi.fn(),
    finalizeDoc: vi.fn(),
  }
})
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.code = code
    }
  },
  getToken: vi.fn(() => 'test-token'),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: () => ({ toast: toastSpy }),
}))

import { getContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'
const FAIL_MSG = '文档信息刷新失败，显示内容可能已过期'

function makeNode(path: string, docId: string): TreeNode {
  return {
    path,
    name: path.split('/').pop()!,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode
}

async function openDoc(docId: string, path: string, content: string) {
  const doc = useDocStore()
  doc.setBook(BOOK)
  vi.mocked(getContent).mockResolvedValueOnce(content)
  await doc.open(makeNode(path, docId))
  return doc
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  toastSpy.mockClear()
})

describe('重审-16 · refresh 失败的 UI 面', () => {
  it('refresh 网络失败 → 返 false + toast warning（修复前静默无 UI 面）', async () => {
    const doc = await openDoc('d1', '写作/正文/0001-开篇.md', '正文')
    vi.mocked(getContent).mockRejectedValueOnce(new Error('fetch failed'))
    const ok = await doc.refresh('d1')
    expect(ok).toBe(false)
    expect(toastSpy).toHaveBeenCalledWith(FAIL_MSG, 'warning')
  })

  it('对照：refresh 成功 → 不 toast', async () => {
    const doc = await openDoc('d1', '写作/正文/0001-开篇.md', '正文')
    vi.mocked(getContent).mockResolvedValueOnce('新正文')
    const ok = await doc.refresh('d1')
    expect(ok).toBe(true)
    expect(toastSpy).not.toHaveBeenCalled()
  })
})

describe('重审-16 · syncCleanWithTree 失败的 UI 面', () => {
  it('树刷新后 clean 缓存重拉失败 → toast warning（修复前 catch 静默）', async () => {
    const doc = await openDoc('d1', '写作/正文/0001-开篇.md', '正文')
    vi.mocked(getContent).mockRejectedValueOnce(new Error('fetch failed'))
    // curRev 与打开时记录的 treeRev 不同 → 判 stale 触发重拉
    await doc.syncCleanWithTree(BOOK, 'tree-rev-2')
    expect(toastSpy).toHaveBeenCalledWith(FAIL_MSG, 'warning')
  })

  it('对照：重拉成功 → 不 toast；条目对齐后 treeRev 推进', async () => {
    const doc = await openDoc('d1', '写作/正文/0001-开篇.md', '旧正文')
    vi.mocked(getContent).mockResolvedValueOnce('新正文（外部改动）')
    await doc.syncCleanWithTree(BOOK, 'tree-rev-2')
    expect(doc.get('d1')!.content).toBe('新正文（外部改动）')
    expect(doc.get('d1')!.treeRev).toBe('tree-rev-2')
    expect(toastSpy).not.toHaveBeenCalled()
  })

  it('重拉在途切书 → 失败 toast 不落新书界面（对齐上方 await 窗口复检守卫）', async () => {
    const doc = await openDoc('d1', '写作/正文/0001-开篇.md', '正文')
    let rejectGet!: (e: Error) => void
    vi.mocked(getContent).mockReturnValueOnce(
      new Promise((_res, rej) => {
        rejectGet = rej
      }),
    )
    const p = doc.syncCleanWithTree(BOOK, 'tree-rev-2')
    doc.setBook('另一本书') // 在途切书
    rejectGet(new Error('fetch failed'))
    await p
    expect(toastSpy).not.toHaveBeenCalled()
  })
})
