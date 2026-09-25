/**
 * F7（五十九轮）+ R64-31（十二轮批 A）——doc store docs Map 缓存驱逐行为
 * （原 f7-doc-lru-evict + r64-switch-guards R64-31 节，装置同构合并）。
 *
 * - F7：clean 文档 LRU 驱逐（上限 20）。非 active、非 dirty 的 entry 超限驱逐；
 *   dirty/conflict 永不驱逐；active 永不驱逐。
 * - R64-31：doc 缓存命中重排——evictLRU 真 LRU（重开命中条目移到最新位，
 *   交替使用的文档不被误驱逐）。
 *
 * 环境：本文件为 node 环境（无 happy-dom pragma）。R43-14（四十三轮）：
 * loadBookPrefs 失败分支新增 ps.apply()（清书级覆盖值后同步 CSS 变量）——node 下无
 * document 会抛；对齐 tree-expanded-prefs-guard（原 r29-fe-e3-e6-stores E-3）先例 stub 掉（本文件不测 CSS 注入）。
 * 下方 R64-32 沿革用例的 getBookPrefs 走真实 api（node 下相对 URL fetch 必失败）
 * 恰好进失败分支（该用例已迁 workspace-tree-expanded-reset.test.ts）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const getContent = vi.hoisted(() => vi.fn())
vi.mock('../../../src/studio/web-next/src/api/documents', () => {
  return {
    getContent,
    // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock(suspect 分支默认不触发)
    getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
    saveContent: vi.fn(),
  }
})
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})
// R0916-6-P2-5：ui store 不再 mock——真件（本文件不断言 toast，副作用无害；纪律见 helpers/real-stores）
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: () => ({
    bookPageWidth: null,
    bookAutosaveInterval: null,
    apply: vi.fn(),
  }),
}))

import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(getContent).mockResolvedValue('内容')
})

function node(id: string): TreeNode {
  return {
    path: `写作/正文/${id}.md`,
    name: `${id}.md`,
    isDirectory: false,
    role: 'chapter',
    docId: id,
    children: [],
  } as TreeNode
}

async function openDocs(ids: string[]): Promise<void> {
  const doc = useDocStore()
  doc.setBook('test-book')
  for (const id of ids) await doc.open(node(id))
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

describe('R64-31: doc 缓存命中重排（evictLRU 真 LRU）', () => {
  it('重开在缓存中的文档 → 移到最新位；后续驱逐淘汰的是真实最久未用', async () => {
    await openDocs(Array.from({ length: 22 }, (_, i) => `d${i + 1}`))
    const doc = useDocStore()
    expect(doc.docs.size).toBe(20)
    expect(doc.get('d1')).toBeUndefined() // 插入序最旧两个出局
    // 重开 d3（命中重排）→ 再开 d23：应驱逐 d4（真实最久未用），d3 存活
    await doc.open(node('d3'))
    await doc.open(node('d23'))
    expect(doc.get('d3')).toBeDefined()
    expect(doc.get('d4')).toBeUndefined()
    expect(doc.docs.size).toBe(20)
  })
})
