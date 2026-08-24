/**
 * F7（五十九轮）回归：doc store docs Map 的 clean 文档 LRU 驱逐（上限 20）。
 * 非 active、非 dirty 的 entry 超限驱逐；dirty/conflict 永不驱逐；active 永不驱逐。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {},
  getToken: vi.fn(() => 'test-token'),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: () => ({ toast: vi.fn() }),
}))

import { getContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(getContent).mockResolvedValue('内容')
})

async function openDocs(ids: string[]): Promise<void> {
  const doc = useDocStore()
  doc.setBook('test-book')
  for (const id of ids) {
    await doc.open({
      path: `写作/正文/${id}.md`,
      name: `${id}.md`,
      isDirectory: false,
      role: 'chapter',
      docId: id,
      children: [],
    } as TreeNode)
  }
}

describe('F7: docs Map LRU 驱逐（上限 20）', () => {
  it('open 第 21+ 篇 → 最旧 clean 文档被驱逐，缓存封顶 20', async () => {
    const ids = Array.from({ length: 22 }, (_, i) => `d${i + 1}`)
    await openDocs(ids)
    const doc = useDocStore()
    expect(doc.docs.size).toBe(20) // 修复点：不再无限常驻
    // 插入序驱逐：最旧的 d1/d2 出（d22 最新落位、active 无关项按插入序裁剪）
    expect(doc.get('d1')).toBeUndefined()
    expect(doc.get('d2')).toBeUndefined()
    expect(doc.get('d3')).toBeDefined()
    expect(doc.get('d22')).toBeDefined()
  })

  it('dirty 文档永不驱逐（未落盘编辑不可丢）', async () => {
    await openDocs(Array.from({ length: 5 }, (_, i) => `d${i + 1}`))
    const doc = useDocStore()
    doc.patch('d1', '改') // 最旧的一篇变脏
    await openDocs(Array.from({ length: 18 }, (_, i) => `e${i + 1}`)) // 共 23 篇
    expect(doc.docs.size).toBe(20)
    expect(doc.get('d1')).toBeDefined() // dirty 项保留
    expect(doc.get('d1')!.content).toBe('改')
    // clean 项从最旧开始补位驱逐：d2、d3 出局
    expect(doc.get('d2')).toBeUndefined()
    expect(doc.get('d3')).toBeUndefined()
  })

  it('conflict 文档永不驱逐；active 文档永不驱逐', async () => {
    await openDocs(Array.from({ length: 5 }, (_, i) => `d${i + 1}`))
    const doc = useDocStore()
    doc.get('d2')!.conflict = true
    useWorkspaceStore().activeDocId = 'd3' // active 指向 d3
    await openDocs(Array.from({ length: 18 }, (_, i) => `e${i + 1}`))
    expect(doc.get('d2')).toBeDefined() // conflict 保留
    expect(doc.get('d3')).toBeDefined() // active 保留
    expect(doc.docs.size).toBe(20)
  })

  it('上限内不驱逐（正常翻章不受影响）', async () => {
    await openDocs(Array.from({ length: 20 }, (_, i) => `d${i + 1}`))
    const doc = useDocStore()
    expect(doc.docs.size).toBe(20)
    expect(doc.get('d1')).toBeDefined()
  })
})
