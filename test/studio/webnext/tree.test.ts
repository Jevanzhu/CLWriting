/**
 * tree store 测试（T4.4 第二批）：groupTree 虚拟分组（移植旧 FileTree，平价基准）
 * + byPath/byDocId 索引 + load 错误态。
 *
 * groupTree 规则：写作(虚拟:正文卷章+草稿) / 大纲(总纲置顶+摘要次之) / 设定提升 / 文风原样。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getTree: vi.fn(),
}))

import { getTree } from '../../../src/studio/web-next/src/api/books'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'

function leaf(path: string, docId: string, status?: string): TreeNode {
  return {
    path,
    name: path.split('/').pop()!.replace(/\.md$/, ''),
    isDirectory: false,
    docId,
    status: status as TreeNode['status'],
    children: [],
  } as TreeNode
}
function dir(path: string, children: TreeNode[]): TreeNode {
  return { path, name: path.split('/').pop()!, isDirectory: true, children } as TreeNode
}

/** 模拟一套完整书库 raw nodes（覆盖分组各区域）。 */
function sampleRaw(): TreeNode[] {
  return [
    dir('定稿', [
      dir('定稿/正文', [
        dir('定稿/正文/第一卷', [
          leaf('定稿/正文/第一卷/第1章-x.md', 'doc1'),
          leaf('定稿/正文/第一卷/第2章-x.md', 'doc2'),
        ]),
      ]),
      dir('定稿/设定', [leaf('定稿/设定/人物.md', 'doc3')]),
      dir('定稿/摘要', [leaf('定稿/摘要/摘要.md', 'doc4')]),
    ]),
    dir('大纲', [leaf('大纲/总纲.md', 'doc5'), leaf('大纲/分卷纲.md', 'doc6')]),
    dir('工作区', [
      leaf('工作区/草稿-1.md', 'doc7', 'draft'),
      leaf('工作区/notes.md', 'doc8'),
    ]),
    dir('文风', [leaf('文风/风格.md', 'doc9')]),
  ]
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('tree · load', () => {
  it('getTree → raw + revision + loading 归位', async () => {
    getTree.mockResolvedValue({ ok: true, nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    const tree = useTreeStore()
    await tree.load(BOOK)
    expect(tree.loading).toBe(false)
    expect(tree.error).toBeNull()
    expect(tree.revision).toBe('r1')
    expect(tree.raw).toHaveLength(4)
  })

  it('getTree 失败 → error 记录', async () => {
    getTree.mockRejectedValue(new Error('网络断'))
    const tree = useTreeStore()
    await tree.load(BOOK)
    expect(tree.error).toBe('网络断')
    expect(tree.loading).toBe(false)
  })
})

describe('tree · groupTree 虚拟分组（平价基准）', () => {
  async function setup() {
    getTree.mockResolvedValue({ ok: true, nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    const tree = useTreeStore()
    await tree.load(BOOK)
    return tree
  }

  it('写作（虚拟）：正文卷子树 + 工作区草稿', async () => {
    const tree = await setup()
    const write = tree.grouped.find((g) => g.path === '写作')!
    expect(write).toBeTruthy()
    expect(write.children.some((c) => c.path === '定稿/正文/第一卷')).toBe(true)
    // 草稿 doc7 抽到写作区
    expect(write.children.some((c) => c.docId === 'doc7')).toBe(true)
  })

  it('大纲：总纲置顶 + 摘要次之 + 其余在后', async () => {
    const tree = await setup()
    const dagang = tree.grouped.find((g) => g.path === '大纲')!
    expect(dagang.children[0].name).toBe('总纲')
    expect(dagang.children[1]?.path).toBe('定稿/摘要') // 摘要并入第二位
    expect(dagang.children[2]?.name).toBe('分卷纲')
  })

  it('设定提升到根级', async () => {
    const tree = await setup()
    expect(tree.grouped.some((g) => g.path === '定稿/设定')).toBe(true)
  })

  it('文风原样保留', async () => {
    const tree = await setup()
    expect(tree.grouped.some((g) => g.path === '文风')).toBe(true)
  })

  it('工作区非草稿文件不进树', async () => {
    const tree = await setup()
    expect(JSON.stringify(tree.grouped)).not.toContain('doc8')
  })

  it('定稿原始根不再独立出现（被拆解到各组）', async () => {
    const tree = await setup()
    expect(tree.grouped.some((g) => g.path === '定稿')).toBe(false)
  })
})

describe('tree · 索引', () => {
  it('byPath 含虚拟组 + 真实节点', async () => {
    getTree.mockResolvedValue({ ok: true, nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    const tree = useTreeStore()
    await tree.load(BOOK)
    expect(tree.byPath.has('写作')).toBe(true)
    expect(tree.byPath.has('定稿/正文/第一卷/第1章-x.md')).toBe(true)
  })

  it('byDocId 索引叶子（含被抽到写作的草稿）', async () => {
    getTree.mockResolvedValue({ ok: true, nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    const tree = useTreeStore()
    await tree.load(BOOK)
    expect(tree.byDocId.get('doc1')?.path).toBe('定稿/正文/第一卷/第1章-x.md')
    expect(tree.byDocId.get('doc7')?.path).toBe('工作区/草稿-1.md')
  })
})
