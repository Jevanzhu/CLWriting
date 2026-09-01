// @vitest-environment happy-dom
/**
 * R35-32（三十五轮）回归：他窗 rename/move 后 doc 缓存 entry.path 对账回填。
 * 修复前：syncCleanWithTree 按旧路径 getContent 静默 404、保存后的树字数局部更新
 * updateWordCount(旧path) 永远 no-op。修复后：syncCleanWithTree 按 docId 命中树节点
 * 即回填 path/name/role/mode（dirty/conflict 项也回填路径元数据），刷新与保存链路
 * 重新对齐新路径。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
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

import { getContent, saveContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { countWords, stripFrontmatter } from '../../../src/studio/web-next/src/shared/words'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = '书A'
const OLD_PATH = '写作/正文/第一卷/0001-旧名.md'
const NEW_PATH = '写作/正文/第一卷/0002-新名.md'

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

async function openDoc(): Promise<ReturnType<typeof useDocStore>> {
  const doc = useDocStore()
  doc.setBook(BOOK)
  vi.mocked(getContent).mockResolvedValueOnce('---\n标题: 旧名\n---\n\n正文内容')
  await doc.open(makeNode(OLD_PATH, 'd1'))
  return doc
}

/** 他窗改名后树已刷新：新路径节点 + 树版本推进 */
function applyRenamedTree(tree: ReturnType<typeof useTreeStore>): TreeNode {
  const node = makeNode(NEW_PATH, 'd1')
  node.wordCount = 0
  tree.raw = [node]
  tree.ownerBook = BOOK
  tree.revision = 'r2'
  return node
}

describe('R35-32: syncCleanWithTree 路径对账回填', () => {
  it('clean 缓存项：回填新路径 + 按新路径重拉内容', async () => {
    const doc = await openDoc()
    const tree = useTreeStore()
    const entry = doc.get('d1')!
    expect(entry.path).toBe(OLD_PATH)

    const node = applyRenamedTree(tree)
    vi.mocked(getContent).mockResolvedValueOnce('---\n标题: 新名\n---\n\n新内容')
    await doc.syncCleanWithTree(BOOK, 'r2')

    // 修复点：entry.path 回填（修复前保持旧路径，getContent('书A', 旧path) 404 静默失败）
    expect(entry.path).toBe(NEW_PATH)
    expect(entry.name).toBe(node.name)
    expect(entry.content).toBe('---\n标题: 新名\n---\n\n新内容')
    expect(entry.treeRev).toBe('r2')
    expect(vi.mocked(getContent)).toHaveBeenLastCalledWith(BOOK, NEW_PATH)
  })

  it('dirty 缓存项：不覆盖内容，但路径元数据仍回填——保存后树字数更新生效', async () => {
    const doc = await openDoc()
    const tree = useTreeStore()
    const entry = doc.get('d1')!
    doc.patch('d1', '---\n标题: 新名\n---\n\n' + '作者的新编辑')
    expect(entry.dirty).toBe(true)

    const node = applyRenamedTree(tree)
    await doc.syncCleanWithTree(BOOK, 'r2')

    // dirty 不重拉内容（CC-P2-15 本地优先），但路径已对齐
    expect(entry.path).toBe(NEW_PATH)
    expect(entry.content).toBe('---\n标题: 新名\n---\n\n' + '作者的新编辑')

    // 保存 → 树字数按新路径局部更新（修复前 updateWordCount(旧path) no-op）
    const content = entry.content
    vi.mocked(saveContent).mockResolvedValueOnce({ ok: true, revision: `sha256:${'b'.repeat(64)}`, superseded: false })
    await doc.save('d1', 'manual')
    const expected = countWords(stripFrontmatter(content))
    expect(node.wordCount).toBe(expected)
  })
})
