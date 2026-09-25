/**
 * clean 缓存对账（syncCleanWithTree）行为族——按行为合并三散落文件
 * （原 r16-doc-refresh-fail-toast 的 syncCleanWithTree 节 / r35-doc-path-reconcile /
 * r29-fe-e3-e6-stores 的 E-4 节，node 环境，装置同构）。
 *
 * - 重审-16（2026-09-07 全量代码重审 §四.16）：树刷新后 clean 缓存重拉失败 → toast
 *   warning「文档信息刷新失败，显示内容可能已过期」（修复前 catch 静默）；重拉在途切书
 *   → 失败 toast 不落新书界面。
 * - R35-32（三十五轮）：他窗 rename/move 后 doc 缓存 entry.path 对账回填。修复前：
 *   syncCleanWithTree 按旧路径 getContent 静默 404、保存后的树字数局部更新
 *   updateWordCount(旧path) 永远 no-op。修复后：按 docId 命中树节点即回填
 *   path/name/role/mode（dirty/conflict 项也回填路径元数据）。
 * - E-4（二十九轮批 E）：clean 文档缓存新鲜度对账——tree store load 成功后按树版本对
 *   打开时记录旧版本的 clean 缓存项静默重拉；dirty/conflict/saving 不动。
 *   0918二轮修复批（E107）：syncCleanWithTree 回写前复检 tree.revision === curRev。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const getContent = vi.hoisted(() => vi.fn())
vi.mock('../../../src/studio/web-next/src/api/documents', () => {
  return {
    getContent,
    // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock(suspect 分支默认不触发)
    getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
    saveContent: vi.fn(),
    finalizeDoc: vi.fn(),
  }
})
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getTree: vi.fn(async () => ({ nodes: [], revision: 'r0' })),
}))
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})
// prefs store 的 apply() 触碰 document（node 环境无 DOM）——stub 掉，本文件不测 CSS 注入
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: () => ({
    bookPageWidth: null,
    bookAutosaveInterval: null,
    apply: vi.fn(),
  }),
}))

import { saveContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { countWords, stripFrontmatter } from '../../../src/studio/web-next/src/shared/words'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'
import { setupRealStores, recordToasts } from './helpers/real-stores'

const BOOK = 'test-book'
const FAIL_MSG = '文档信息刷新失败，显示内容可能已过期'
const OLD_PATH = '写作/正文/第一卷/0001-旧名.md'
const NEW_PATH = '写作/正文/第一卷/0002-新名.md'

function makeNode(pathOrDocId: string, docId?: string): TreeNode {
  const path = docId === undefined ? `写作/正文/${pathOrDocId}.md` : pathOrDocId
  const id = docId ?? pathOrDocId
  return {
    path,
    name: path.split('/').pop()!,
    isDirectory: false,
    role: 'chapter',
    docId: id,
    children: [],
  } as TreeNode
}

// dirty 镜像等 localStorage 面：Map 替身（node 环境稳）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
vi.stubGlobal('localStorage', createLocalStorage())

let toastSpy: ReturnType<typeof recordToasts>

beforeEach(() => {
  vi.clearAllMocks()
  // 真 pinia + 真 store（toast 用 spy 录制，调用照常生效）
  toastSpy = recordToasts(setupRealStores().ui)
})

// ── 重审-16：syncCleanWithTree 失败的 UI 面 ────────────────────────

describe('重审-16 · syncCleanWithTree 失败的 UI 面', () => {
  // 0918二轮修复批（E107）：syncCleanWithTree 回写前复检 tree.revision === curRev——
  // 直接调用须对齐真实时序（tree.doLoad 落定 revision 后以同值发起本批），否则迟到
  // 复检按「树已前进」弃写。
  function syncAtRev(doc: ReturnType<typeof useDocStore>, rev: string): Promise<void> {
    useTreeStore().revision = rev
    return doc.syncCleanWithTree(BOOK, rev)
  }

  async function openDoc(docId: string, path: string, content: string) {
    const doc = useDocStore()
    doc.setBook(BOOK)
    vi.mocked(getContent).mockResolvedValueOnce(content)
    await doc.open(makeNode(path, docId))
    return doc
  }

  it('树刷新后 clean 缓存重拉失败 → toast warning（修复前 catch 静默）', async () => {
    const doc = await openDoc('d1', '写作/正文/0001-开篇.md', '正文')
    vi.mocked(getContent).mockRejectedValueOnce(new Error('fetch failed'))
    // curRev 与打开时记录的 treeRev 不同 → 判 stale 触发重拉
    await syncAtRev(doc, 'tree-rev-2')
    expect(toastSpy).toHaveBeenCalledWith(FAIL_MSG, 'warning')
  })

  it('对照：重拉成功 → 不 toast；条目对齐后 treeRev 推进', async () => {
    const doc = await openDoc('d1', '写作/正文/0001-开篇.md', '旧正文')
    vi.mocked(getContent).mockResolvedValueOnce('新正文（外部改动）')
    await syncAtRev(doc, 'tree-rev-2')
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
    const p = syncAtRev(doc, 'tree-rev-2')
    doc.setBook('另一本书') // 在途切书
    rejectGet(new Error('fetch failed'))
    await p
    expect(toastSpy).not.toHaveBeenCalled()
  })
})

// ── R35-32：路径对账回填 ────────────────────────

describe('R35-32: syncCleanWithTree 路径对账回填', () => {
  async function openDoc(): Promise<ReturnType<typeof useDocStore>> {
    const doc = useDocStore()
    doc.setBook('书A')
    vi.mocked(getContent).mockResolvedValueOnce('---\n标题: 旧名\n---\n\n正文内容')
    await doc.open(makeNode(OLD_PATH, 'd1'))
    return doc
  }

  /** 他窗改名后树已刷新：新路径节点 + 树版本推进 */
  function applyRenamedTree(tree: ReturnType<typeof useTreeStore>): TreeNode {
    const node = makeNode(NEW_PATH, 'd1')
    node.wordCount = 0
    tree.raw = [node]
    tree.ownerBook = '书A'
    tree.revision = 'r2'
    return node
  }

  it('clean 缓存项：回填新路径 + 按新路径重拉内容', async () => {
    const doc = await openDoc()
    const tree = useTreeStore()
    const entry = doc.get('d1')!
    expect(entry.path).toBe(OLD_PATH)

    const node = applyRenamedTree(tree)
    vi.mocked(getContent).mockResolvedValueOnce('---\n标题: 新名\n---\n\n新内容')
    await doc.syncCleanWithTree('书A', 'r2')

    // 修复点：entry.path 回填（修复前保持旧路径，getContent('书A', 旧path) 404 静默失败）
    expect(entry.path).toBe(NEW_PATH)
    expect(entry.name).toBe(node.name)
    expect(entry.content).toBe('---\n标题: 新名\n---\n\n新内容')
    expect(entry.treeRev).toBe('r2')
    expect(vi.mocked(getContent)).toHaveBeenLastCalledWith('书A', NEW_PATH)
  })

  it('dirty 缓存项：不覆盖内容，但路径元数据仍回填——保存后树字数更新生效', async () => {
    const doc = await openDoc()
    const tree = useTreeStore()
    const entry = doc.get('d1')!
    doc.patch('d1', '---\n标题: 新名\n---\n\n' + '作者的新编辑')
    expect(entry.dirty).toBe(true)

    const node = applyRenamedTree(tree)
    await doc.syncCleanWithTree('书A', 'r2')

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

// ── E-4：树刷新后 clean 缓存新鲜度对账 ────────────────────────

describe('E-4: 树刷新后 clean 缓存新鲜度对账', () => {
  it('树版本推进 → 打开时记录旧版本的 clean 项静默重拉对齐磁盘', async () => {
    vi.mocked(getContent).mockReset()
    const { getTree } = (await vi.importMock('../../../src/studio/web-next/src/api/books')) as {
      getTree: ReturnType<typeof vi.fn>
    }
    getTree.mockResolvedValue({ nodes: [makeNode('d1')], revision: 'r1' })
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook('书A')
    await tree.load('书A', true)
    vi.mocked(getContent).mockResolvedValueOnce('v1')
    await doc.open(makeNode('d1'))
    expect(doc.get('d1')!.content).toBe('v1')
    expect(doc.get('d1')!.treeRev).toBe('r1')

    // 盘上被外部改掉 + 树重扫推进版本
    vi.mocked(getContent).mockResolvedValue('v2')
    getTree.mockResolvedValue({ nodes: [makeNode('d1')], revision: 'r2' })
    await tree.load('书A', true)
    await vi.waitFor(() => expect(doc.get('d1')!.content).toBe('v2')) // 静默重拉到位
    expect(doc.get('d1')!.treeRev).toBe('r2')
    expect(doc.get('d1')!.dirty).toBe(false)
  })

  it('dirty/conflict 缓存项不对账（本地编辑优先），同版本树不重拉', async () => {
    const { getTree } = (await vi.importMock('../../../src/studio/web-next/src/api/books')) as {
      getTree: ReturnType<typeof vi.fn>
    }
    getTree.mockResolvedValue({ nodes: [makeNode('d1')], revision: 'r1' })
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook('书A')
    await tree.load('书A', true)
    vi.mocked(getContent).mockResolvedValueOnce('v1')
    await doc.open(makeNode('d1'))
    doc.patch('d1', '本地未保存编辑')

    vi.mocked(getContent).mockClear()
    vi.mocked(getContent).mockResolvedValue('盘上新版')
    getTree.mockResolvedValue({ nodes: [makeNode('d1')], revision: 'r2' })
    await tree.load('书A', true)
    await Promise.resolve()
    await Promise.resolve()
    expect(doc.get('d1')!.content).toBe('本地未保存编辑') // dirty 不被静默覆盖
    expect(vi.mocked(getContent)).not.toHaveBeenCalled() // dirty 项不发起重拉

    // 同版本树再 load → clean 项也不重拉（无版本差）
    doc.get('d1')!.dirty = false
    doc.get('d1')!.treeRev = 'r2'
    vi.mocked(getContent).mockClear()
    await tree.load('书A', true)
    await Promise.resolve()
    await Promise.resolve()
    expect(vi.mocked(getContent)).not.toHaveBeenCalled()
  })
})
