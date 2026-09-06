/**
 * R51-H-3（五十一轮）回归：doc.refresh 成功分支推进 treeRev（对齐 doSave 成功分支口径）。
 *
 * refresh（外部改动后的静默对齐）成功后不推进 treeRev → syncCleanWithTree 的 stale 过滤
 * （treeRev !== curRev 且非 dirty/conflict/saving）恒命中，refreshed 文档此后每次树刷新
 * 都被冗余重拉（每文档 GET + sha256 白耗）。修复后 refresh 两个成功分支都按当前树版本
 * 视作新鲜。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
}))
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
  useUiStore: () => ({ toast: vi.fn() }),
}))

import { getContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'A书'

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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('R51-H-3: doc.refresh 推进 treeRev', () => {
  it('clean 分支：refresh 成功 → treeRev 对齐当前树版本（旧实现停在开档时版本，syncCleanWithTree 每次树刷新判 stale 冗余重拉）', async () => {
    const doc = useDocStore()
    doc.setBook(BOOK)
    vi.mocked(getContent).mockResolvedValueOnce('初始内容')
    await doc.open(makeNode('写作/正文/0001-第一章.md', 'd1'))
    const e = doc.get('d1')!
    const tree = useTreeStore()
    expect(e.treeRev).toBe(tree.revision) // open 记录开档时树版本

    tree.revision = 'rev-B' // 树刷新推进版本（外部改动触发）
    vi.mocked(getContent).mockResolvedValueOnce('外部改了 fm 的新内容')
    await expect(doc.refresh('d1')).resolves.toBe(true)
    expect(e.treeRev).toBe('rev-B') // 修复点：不再停在旧版本
  })

  it('dirty 合并分支（CC-P2-15）：refresh 保留本地正文成功 → treeRev 同样推进', async () => {
    const doc = useDocStore()
    doc.setBook(BOOK)
    vi.mocked(getContent).mockResolvedValueOnce('---\n标题: 一\n---\n\n正文')
    await doc.open(makeNode('写作/正文/0002-第二章.md', 'd2'))
    const tree = useTreeStore()
    tree.revision = 'rev-C'
    doc.patch('d2', '---\n标题: 一\n---\n\n本地未保存编辑')
    vi.mocked(getContent).mockResolvedValueOnce('---\n标题: 一（外部改）\n---\n\n正文')
    await expect(doc.refresh('d2')).resolves.toBe(true)
    const e = doc.get('d2')!
    expect(e.dirty).toBe(true) // 本地编辑保留
    expect(e.content).toContain('本地未保存编辑')
    expect(e.treeRev).toBe('rev-C') // 修复点：dirty 分支也推进
  })
})
