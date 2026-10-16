/**
 * tree store 测试（T4.4 第二批）：groupTree 分组（v2 直透）
 * + byPath/byDocId 索引 + load 错误态。
 *
 * groupTree 规则（v2）：后端已返回最终目录树（写作/大纲/设定/布线），
 * 前端仅过滤根级散文件 + 设定/名册.md（幕后资产）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getTree: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/tree-issues', () => ({
  getTreeIssues: vi.fn(),
}))

import { getTree } from '../../../src/studio/web-next/src/api/books'
import { getTreeIssues } from '../../../src/studio/web-next/src/api/tree-issues'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { installCrossWindowInvalidation } from '../../../src/studio/web-next/src/composables/useCrossWindowInvalidation'
import { notifyCrossWindow, type CrossWindowPort } from '../../../src/studio/web-next/src/shared/cross-window'
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
    dir('布线', [dir('布线/悬念', [leaf('布线/悬念/悬念-001-x.md', 'doc10')])]),
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
    vi.mocked(getTree).mockImplementationOnce(
      () =>
        new Promise((r) => {
          releaseCache = r
        }),
    )
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
    return {
      path,
      name: path.split('/').pop()!.replace(/\.md$/, ''),
      isDirectory: false,
      role,
      wordCount,
      children: [],
    } as TreeNode
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

// ── 跨窗失效通知（树红点 / 机检判态线）────────────────────────────────
// 收到他窗「红点失效」只当失效信号：走既有 loadIssues（GET /tree-issues）重取全量替换，
// 不接收载荷里的 issues 内容——否则等于用别窗的聚合副本盖掉本窗的权威态。

/** 可注入假通道：不依赖真实跨进程窗口；deliver = 模拟「他窗发来的消息」 */
function createFakePort(): {
  port: CrossWindowPort
  sent: unknown[]
  deliver: (data: unknown) => void
  closed: () => boolean
} {
  const listeners: ((data: unknown) => void)[] = []
  const sent: unknown[] = []
  let isClosed = false
  return {
    port: {
      postMessage: (msg) => void sent.push(msg),
      subscribe: (l) => {
        listeners.push(l)
        return () => {
          const i = listeners.indexOf(l)
          if (i >= 0) listeners.splice(i, 1)
        }
      },
      close: () => {
        isClosed = true
      },
    },
    sent,
    deliver: (data) => {
      for (const l of [...listeners]) l(data)
    },
    closed: () => isClosed,
  }
}

/** 跨窗派发是宏任务（setTimeout 0）+ 其后的重取 await 链——排空一拍再断言 */
async function flushCrossWindow(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('跨窗失效通知（树红点 / 机检判态线）', () => {
  let dispose: (() => void) | null = null
  afterEach(() => {
    dispose?.()
    dispose = null
  })

  it('通道可用：收到他窗 tree-issues 失效 → 走既有 loadIssues 重取（值来自聚合接口）', async () => {
    vi.mocked(getTree).mockResolvedValue({ nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    vi.mocked(getTreeIssues).mockResolvedValue({ ok: true, issues: {} })
    const tree = useTreeStore()
    await tree.load(BOOK) // raw 属主置位（红点按 ownerBook 归属）
    await flushCrossWindow()
    expect(tree.ownerBook).toBe(BOOK)
    vi.mocked(getTreeIssues).mockClear()

    const fake = createFakePort()
    const h = installCrossWindowInvalidation({ windowId: 'self', createPort: () => fake.port, coalesceMs: 0 })
    dispose = h.dispose
    expect(h.enabled).toBe(true)

    // 他窗跑了机检：权威红点在服务端聚合；广播载荷刻意不带 issues 内容
    vi.mocked(getTreeIssues).mockResolvedValueOnce({
      ok: true,
      issues: { doc1: { hasRed: true, verdictRejected: false } },
    })
    fake.deliver({
      v: 1,
      src: 'other-window',
      topics: ['tree-issues'],
      issues: { doc9: { hasRed: true, verdictRejected: true } },
    })
    await flushCrossWindow()

    expect(getTreeIssues).toHaveBeenCalledTimes(1)
    expect(getTreeIssues).toHaveBeenCalledWith(BOOK)
    expect(tree.issues).toEqual({ doc1: { hasRed: true, verdictRejected: false } }) // 来自接口，非载荷
    expect(tree.issuePaths.has('写作/正文/第一卷/第1章-x.md')).toBe(true) // 红点冒泡随之重建
    expect(fake.sent).toEqual([]) // 回环红线：收到通知触发的重取链自身不再广播
  })

  it('通知不直接改 store 值：重取失败时红点保持原样（不经广播注入）', async () => {
    vi.mocked(getTree).mockResolvedValue({ nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    vi.mocked(getTreeIssues).mockResolvedValue({ ok: true, issues: { doc1: { hasRed: true, verdictRejected: false } } })
    const tree = useTreeStore()
    await tree.load(BOOK)
    await flushCrossWindow()

    const fake = createFakePort()
    dispose = installCrossWindowInvalidation({ windowId: 'self', createPort: () => fake.port, coalesceMs: 0 }).dispose
    vi.mocked(getTreeIssues).mockRejectedValueOnce(new Error('网络断开'))
    fake.deliver({ v: 1, src: 'other-window', topics: ['tree-issues'] })
    await flushCrossWindow()

    // 既有 best-effort 口径：失败保留旧值（不惊扰作者），也不被载荷内容替换
    expect(tree.issues).toEqual({ doc1: { hasRed: true, verdictRejected: false } })
  })

  it('本窗自己的消息被忽略（来源窗 id 自检）——不触发重取', async () => {
    vi.mocked(getTree).mockResolvedValue({ nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    vi.mocked(getTreeIssues).mockResolvedValue({ ok: true, issues: {} })
    const tree = useTreeStore()
    await tree.load(BOOK)
    await flushCrossWindow()
    vi.mocked(getTreeIssues).mockClear()

    const fake = createFakePort()
    const h = installCrossWindowInvalidation({ windowId: 'self', createPort: () => fake.port, coalesceMs: 0 })
    dispose = h.dispose
    fake.deliver({ v: 1, src: h.windowId, topics: ['tree-issues'] })
    await flushCrossWindow()

    expect(getTreeIssues).not.toHaveBeenCalled()
  })

  it('未开书（raw 无属主）时通知不触发请求（无树可对齐）', async () => {
    vi.mocked(getTreeIssues).mockResolvedValue({ ok: true, issues: {} })
    const tree = useTreeStore() // 不 load：ownerBook 为空
    const fake = createFakePort()
    dispose = installCrossWindowInvalidation({ windowId: 'self', createPort: () => fake.port, coalesceMs: 0 }).dispose
    fake.deliver({ v: 1, src: 'other-window', topics: ['tree-issues'] })
    await flushCrossWindow()

    expect(tree.ownerBook).toBe('')
    expect(getTreeIssues).not.toHaveBeenCalled()
  })

  it('通道不可用（工厂返回 null）→ 装配不抛（enabled=false）、广播 no-op、既有 load 照旧', async () => {
    vi.mocked(getTree).mockResolvedValue({ nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    vi.mocked(getTreeIssues).mockResolvedValue({ ok: true, issues: {} })
    const h = installCrossWindowInvalidation({ createPort: () => null })
    dispose = h.dispose
    expect(h.enabled).toBe(false)
    expect(() => notifyCrossWindow(['tree-issues'])).not.toThrow()

    const tree = useTreeStore()
    await tree.load(BOOK)
    await flushCrossWindow()
    expect(tree.raw).toHaveLength(6) // 功能照旧
    expect(getTreeIssues).toHaveBeenCalledWith(BOOK)
  })
})

// ── 红点降级提示接线（服务端 warnings 数组 → store.issueWarnings → 树面板提示行）──
// 服务端四类降级(机检索引构建失败 / 账本全书性项失败 / 单章机检失败 / 清单读失败)下
// 红点不完整;前端不提示则作者把「没有红点」读成「本章没问题」。此处锚接线可观察面:
// 接口 warnings 原样入 store,无降级时清空(不滞留上一轮)。面板渲染面见 DOM 用例。

describe('树红点降级提示接线(issueWarnings)', () => {
  it('接口 warnings 原样入 store;下一轮无降级即清空(不滞留)', async () => {
    vi.mocked(getTree).mockResolvedValue({ nodes: sampleRaw(), revision: 'r1', validatedAt: '' })
    vi.mocked(getTreeIssues).mockResolvedValueOnce({
      ok: true,
      issues: {},
      warnings: ['机检索引构建失败,仅显示审稿驳回红点', '3 个章节本轮机检失败,对应红点可能缺失'],
    })
    const tree = useTreeStore()
    await tree.load(BOOK)
    await flushCrossWindow()
    expect(tree.issueWarnings).toEqual(['机检索引构建失败,仅显示审稿驳回红点', '3 个章节本轮机检失败,对应红点可能缺失'])

    // 第二轮无降级:上一轮说明必须清掉,否则修好之后仍长挂提示
    vi.mocked(getTreeIssues).mockResolvedValueOnce({ ok: true, issues: {} })
    await tree.loadIssues(BOOK)
    expect(tree.issueWarnings).toEqual([])
  })

  it('clear 一并清空降级说明(切书不留前书提示)', async () => {
    vi.mocked(getTreeIssues).mockResolvedValueOnce({ ok: true, issues: {}, warnings: ['清单读取失败'] })
    const tree = useTreeStore()
    await tree.loadIssues(BOOK)
    expect(tree.issueWarnings).toEqual(['清单读取失败'])
    tree.clear()
    expect(tree.issueWarnings).toEqual([])
  })
})
