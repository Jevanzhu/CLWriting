/**
 * tree store 测试（T4.4 第二批）：groupTree 分组（v2 直透）
 * + byPath/byDocId 索引 + load 错误态。
 *
 * groupTree 规则（v2）：后端已返回最终目录树（写作/大纲/设定/布线），
 * 前端仅过滤根级散文件 + 设定/名册.md（幕后资产）。
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
    role: 'chapter',
    docId,
    status: status as TreeNode['status'],
    children: [],
  } as TreeNode
}
function dir(path: string, children: TreeNode[]): TreeNode {
  return { path, name: path.split('/').pop()!, isDirectory: true, role: 'group', children } as TreeNode
}

/** 模拟一套完整书库 raw nodes（v3 目录树，草稿落正文区靠 status 区分）。 */
function sampleRaw(): TreeNode[] {
  return [
    dir('写作', [
      dir('写作/正文', [
        dir('写作/正文/第一卷', [
          leaf('写作/正文/第一卷/第1章-x.md', 'doc1'),
          leaf('写作/正文/第一卷/第2章-x.md', 'doc2'),
        ]),
        leaf('写作/正文/第3章-x.md', 'doc7', 'draft'),
      ]),
    ]),
    dir('大纲', [leaf('大纲/总纲.md', 'doc5'), leaf('大纲/分卷纲.md', 'doc6')]),
    dir('设定', [leaf('设定/人物.md', 'doc3'), leaf('设定/名册.md', 'doc-mingce')]),
    dir('布线', [
      dir('布线/悬念', [leaf('布线/悬念/悬念-001-x.md', 'doc10')]),
    ]),
    // 根级散文件（后端未过滤，前端应过滤）
    leaf('book.yaml', ''),
    leaf('.gitignore', ''),
  ]
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('tree · load', () => {
  it('getTree → raw + revision + loading 归位', async () => {
    vi.mocked(getTree).mockResolvedValue({ nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    const tree = useTreeStore()
    await tree.load(BOOK)
    expect(tree.loading).toBe(false)
    expect(tree.error).toBeNull()
    expect(tree.revision).toBe('r1')
    expect(tree.raw).toHaveLength(6)
  })

  it('getTree 失败 → error 记录', async () => {
    vi.mocked(getTree).mockRejectedValue(new Error('网络断'))
    const tree = useTreeStore()
    await tree.load(BOOK)
    expect(tree.error).toBe('网络断')
    expect(tree.loading).toBe(false)
  })

  it('R46-35（四十六轮）：同书并发 load 合并为一次 GET，settle 后台账清（后续调用重新发请求）', async () => {
    vi.mocked(getTree).mockResolvedValue({ nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    const tree = useTreeStore()
    const p1 = tree.load(BOOK)
    const p2 = tree.load(BOOK)
    await Promise.all([p1, p2])
    expect(getTree).toHaveBeenCalledTimes(1) // 合并为一次请求（原两次且前者被 gen 丢弃）
    expect(tree.revision).toBe('r1')
    await tree.load(BOOK) // settle 后在途清：非永久缓存，再调重发
    expect(getTree).toHaveBeenCalledTimes(2)
  })

  it('R46-35（四十六轮）：在途 refresh=0 时 refresh=1 不搭车（后发者胜）；在途 refresh=1 时后来者搭车', async () => {
    // 在途缓存读（refresh=0）挂起，重扫（refresh=1）并发到达
    let releaseCache!: (v: { nodes: TreeNode[]; revision: string; validatedAt: string }) => void
    vi.mocked(getTree).mockImplementationOnce(() => new Promise((r) => { releaseCache = r }))
    vi.mocked(getTree).mockResolvedValueOnce({ nodes: sampleRaw(), revision: 'r2', validatedAt: '' })
    const tree = useTreeStore()
    const pCache = tree.load(BOOK)
    const pScan = tree.load(BOOK, true) // 不合并：缓存响应满足不了重扫语义，独立发请求
    releaseCache({ nodes: [], revision: 'r-stale', validatedAt: '' })
    await Promise.all([pCache, pScan])
    expect(getTree).toHaveBeenCalledTimes(2)
    expect(tree.revision).toBe('r2') // 重扫响应胜出，迟到的缓存响应被 gen 丢弃

    // 反向：在途是重扫（refresh=1），后来的 refresh=0 直接搭车（重扫响应至少与缓存一样新）
    vi.mocked(getTree).mockResolvedValueOnce({ nodes: sampleRaw(), revision: 'r3', validatedAt: '' })
    const pScan2 = tree.load(BOOK, true)
    const pCache2 = tree.load(BOOK)
    await Promise.all([pScan2, pCache2])
    expect(getTree).toHaveBeenCalledTimes(3) // 搭车未发新请求
    expect(tree.revision).toBe('r3')
  })
})

describe('tree · groupTree 分组（v2 直透）', () => {
  async function setup() {
    vi.mocked(getTree).mockResolvedValue({ nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    const tree = useTreeStore()
    await tree.load(BOOK)
    return tree
  }

  it('写作：真实根目录直透（卷/章 + 正文区草稿）+ 名册过滤', async () => {
    const tree = await setup()
    const write = tree.grouped.find((g) => g.path === '写作')!
    expect(write).toEqual(expect.objectContaining({ path: '写作' }))
    expect(write.children.some((c) => c.path === '写作/正文')).toBe(true)
    expect(write.children.some((c) => c.path === '写作/草稿')).toBe(false)
  })

  it('大纲：真实根目录直透（含总纲）', async () => {
    const tree = await setup()
    const dagang = tree.grouped.find((g) => g.path === '大纲')!
    expect(dagang).toEqual(expect.objectContaining({ path: '大纲' }))
    expect(dagang.children.some((c) => c.path === '大纲/总纲.md')).toBe(true)
    expect(dagang.children.some((c) => c.path === '大纲/分卷纲.md')).toBe(true)
  })

  it('布线：真实根目录直透（不再从大纲抽线索）', async () => {
    const tree = await setup()
    const bx = tree.grouped.find((g) => g.path === '布线')!
    expect(bx).toEqual(expect.objectContaining({ path: '布线' }))
    expect(bx.children.some((c) => c.path === '布线/悬念')).toBe(true)
  })

  it('设定提升根级 + 名册.md 撤出（幕后资产）', async () => {
    const tree = await setup()
    const shezhi = tree.grouped.find((g) => g.path === '设定')!
    expect(shezhi).toEqual(expect.objectContaining({ path: '设定' }))
    expect(shezhi.children.some((c) => c.path === '设定/人物.md')).toBe(true)
    expect(JSON.stringify(tree.grouped)).not.toContain('设定/名册.md')
  })

  it('根级散文件（book.yaml/.gitignore）过滤', async () => {
    const tree = await setup()
    expect(tree.grouped.some((g) => g.path === 'book.yaml')).toBe(false)
    expect(tree.grouped.some((g) => g.path === '.gitignore')).toBe(false)
  })
})

describe('tree · 索引', () => {
  it('byPath 含真实目录 + 叶子', async () => {
    vi.mocked(getTree).mockResolvedValue({ nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    const tree = useTreeStore()
    await tree.load(BOOK)
    expect(tree.byPath.has('写作')).toBe(true)
    expect(tree.byPath.has('写作/正文/第一卷/第1章-x.md')).toBe(true)
  })

  it('byDocId 索引叶子', async () => {
    vi.mocked(getTree).mockResolvedValue({ nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    const tree = useTreeStore()
    await tree.load(BOOK)
    expect(tree.byDocId.get('doc1')?.path).toBe('写作/正文/第一卷/第1章-x.md')
    expect(tree.byDocId.get('doc7')?.path).toBe('写作/正文/第3章-x.md')
  })
})

describe('tree · 字数聚合（totalWords/finalizedWords/updateWordCount）', () => {
  function wleaf(path: string, role: string, wordCount: number): TreeNode {
    return { path, name: path.split('/').pop()!.replace(/\.md$/, ''), isDirectory: false, role, wordCount, children: [] } as TreeNode
  }
  function rawWords(): TreeNode[] {
    return [
      dir('写作', [
        dir('写作/正文', [
          dir('写作/正文/第一卷', [
            wleaf('写作/正文/第一卷/第1章-x.md', 'chapter', 1000),
            wleaf('写作/正文/第一卷/第2章-x.md', 'chapter', 2000),
          ]),
          wleaf('写作/正文/第3章-x.md', 'draft', 300),
        ]),
      ]),
      // 设定非正文，不算字数
      dir('设定', [wleaf('设定/人物.md', 'setting', 500)]),
    ]
  }

  it('totalWords: chapter 求和（draft 不再计入；非正文 role 排除）', async () => {
    vi.mocked(getTree).mockResolvedValue({ nodes: rawWords(), revision: 'r1', validatedAt: '' })
    const tree = useTreeStore()
    await tree.load(BOOK)
    // 1000 + 2000（chapter）= 3000；draft 300 与 setting 500 不算
    expect(tree.totalWords).toBe(3000)
  })

  it('updateWordCount: 局部更新某叶子字数（聚合随之变）', async () => {
    vi.mocked(getTree).mockResolvedValue({ nodes: rawWords(), revision: 'r1', validatedAt: '' })
    const tree = useTreeStore()
    await tree.load(BOOK)
    expect(tree.totalWords).toBe(3000)
    tree.updateWordCount('写作/正文/第一卷/第1章-x.md', 1500) // 1000 → 1500
    expect(tree.totalWords).toBe(3500)
  })
})
