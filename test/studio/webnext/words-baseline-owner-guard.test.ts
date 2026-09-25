/**
 * R35-10（三十五轮）回归（store 面）：words.ensureBaseline 属主校验。
 * 新书 load 失败时 tree.raw/ownerBook 滞留旧书——修复前 ensureBaseline 取
 * bookTotalWords 前不过属主，旧书总字数被 POST 成新书当日基线（服务端
 * words-diary 污染）。修复后：tree.ownerBook ≠ 目标书 → 无基线源，不落基线
 * （今日字数按 0 展示），等树加载成功后的下一次 ensureBaseline。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const apiMocks = vi.hoisted(() => ({
  getTree: vi.fn(),
  getWordsDiary: vi.fn(),
  postBaseline: vi.fn(),
  getTreeIssues: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getTree: apiMocks.getTree,
  getWordsDiary: apiMocks.getWordsDiary,
  postBaseline: apiMocks.postBaseline,
}))
vi.mock('../../../src/studio/web-next/src/api/tree-issues', () => ({
  getTreeIssues: apiMocks.getTreeIssues,
}))

import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useWordsStore } from '../../../src/studio/web-next/src/stores/words'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const TODAY = (() => {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
})()

function makeNode(path: string, docId: string, wordCount: number): TreeNode {
  return { path, name: 'n', isDirectory: false, role: 'chapter', docId, wordCount, children: [] } as TreeNode
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  apiMocks.getTreeIssues.mockResolvedValue({ issues: {} })
})

describe('words: ensureBaseline 属主校验（R35-10）', () => {
  it('新书 load 失败（tree 滞留旧书，ownerBook≠目标书）→ 不把旧书总字数 POST 成新书基线', async () => {
    const tree = useTreeStore()
    // A 书树载入成功：owner=A，总字数 300
    apiMocks.getTree.mockResolvedValueOnce({ nodes: [makeNode('写作/正文/01/0001.md', 'd1', 300)], revision: 'r1' })
    await tree.load('书A', true)
    expect(tree.ownerBook).toBe('书A')

    // 切 B：B load 失败 → raw/ownerBook 滞留 A
    apiMocks.getTree.mockRejectedValueOnce(new Error('down'))
    await tree.load('书B', true)
    expect(tree.error).not.toBeNull()
    expect(tree.ownerBook).toBe('书A')

    // B 的 ensureBaseline：修复前快照 tree.totalWords=300（A 书）→ postBaseline('书B', 300)
    apiMocks.getWordsDiary.mockResolvedValue({ date: TODAY, delta: null, baseline: null })
    apiMocks.postBaseline.mockResolvedValue({ ok: true })
    const words = useWordsStore()
    await words.ensureBaseline('书B')

    expect(apiMocks.postBaseline).not.toHaveBeenCalled() // 无属主基线源 → 不落
    expect(words.baseline).toBeNull() // 今日字数按 0 展示，等树就绪重取
    expect(words.ready).toBe(true)
  })

  it('属主匹配 → 基线照常落（守卫不误伤正常路径）', async () => {
    const tree = useTreeStore()
    apiMocks.getTree.mockResolvedValueOnce({ nodes: [makeNode('写作/正文/01/0001.md', 'd1', 300)], revision: 'r1' })
    await tree.load('书A', true)
    apiMocks.getWordsDiary.mockResolvedValue({ date: TODAY, delta: null, baseline: null })
    apiMocks.postBaseline.mockResolvedValue({ ok: true })
    const words = useWordsStore()
    await words.ensureBaseline('书A')
    expect(apiMocks.postBaseline).toHaveBeenCalledWith('书A', 300)
  })

  it('失败降级路径同过属主校验：owner 不匹配 → baseline 不取旧树总值', async () => {
    const tree = useTreeStore()
    apiMocks.getTree.mockResolvedValueOnce({ nodes: [makeNode('写作/正文/01/0001.md', 'd1', 300)], revision: 'r1' })
    await tree.load('书A', true)
    apiMocks.getWordsDiary.mockRejectedValueOnce(new Error('net down'))
    const words = useWordsStore()
    await words.ensureBaseline('书B') // owner 仍 A
    expect(words.todayDelta).toBeNull()
    expect(words.baseline).toBeNull() // 修复前 = tree.totalWords（A 书 300）
  })
})
