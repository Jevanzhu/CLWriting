// @vitest-environment happy-dom
/**
 * R-P2-1（评审修复批）回归：dirty 镜像键族清理缺失面收敛。
 *
 * 评审证实：头注声明的清理面（clean/文档删除/切书）之外，还有四条链会让镜像键
 * 滞留 localStorage，同 id 重建文档（legacy docId 按路径派生，同路径复用同 id）
 * 时 open 误复活旧镜像污染新文档：
 * ① doOpen 404（打开失败：文档已被删/指向已删路径）——镜像成无主孤儿；
 * ② 文档改名（op=rename / op=meta 路径同步 rename）——legacy id 旧键孤儿化；
 * ③ 书改名——经查已被切书链 doc.setBook(新名) → clearBookMirrors(旧名) 覆盖
 *    （SettingsBook 改名成功 router.replace → Book.vue watch → doc.setBook），
 *    本文件补表征用例钉住该落点；
 * ④ 删书——前端落点在 useShelf.confirmDelete（本批文件互斥禁改），交付面 =
 *    doc store 导出清理单源（clearBookMirrors / clearDirtyMirror），供该链一行接线。
 * mock 与夹具沿用 r55-f3-dirty-mirror.test.ts 惯例。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const toastMock = vi.hoisted(() => vi.fn())
const treeMock = vi.hoisted(() => ({
  revision: 'r0',
  grouped: [] as unknown[],
  byPath: new Map(),
  byDocId: new Map(),
  load: vi.fn(async () => {}),
  updateWordCount: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => {
  const getContent = vi.fn()
  return {
    getContent,
    // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock(suspect 分支默认不触发)
    getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
    saveContent: vi.fn(),
    finalizeDoc: vi.fn(),
    createDoc: vi.fn(),
    renameDoc: vi.fn(),
    moveDoc: vi.fn(),
    copyDoc: vi.fn(),
    deleteDoc: vi.fn(),
    updateChapterMetaDoc: vi.fn(),
    batchFinalizeDocs: vi.fn(),
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
  useUiStore: () => ({ toast: toastMock, ask: vi.fn(async () => true) }),
}))
vi.mock('../../../src/studio/web-next/src/stores/words', () => ({
  useWordsStore: () => ({ ensureBaseline: vi.fn(async () => {}) }),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: () => treeMock,
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: () => ({ activeDocId: null, openTab: vi.fn() }),
}))
vi.mock('../../../src/studio/web-next/src/stores/check', () => ({
  clearFalsePositiveMarksForDoc: vi.fn(),
}))

import { getContent, renameDoc, updateChapterMetaDoc } from '../../../src/studio/web-next/src/api/documents'
import { ApiError } from '../../../src/studio/web-next/src/api/client'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

// happy-dom localStorage 在 vitest 集成下缺 clear()/length，Map-backed 替身（r30 范型）
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

const KEY = (book: string, docId: string): string => `clw:dirty-mirror:${book}:${docId}`

/** 直接落一条镜像（与 writeDirtyMirror 的 payload 同构；带 baseRev 走可复活形态） */
function putMirror(book: string, docId: string, content: string): void {
  localStorage.setItem(KEY(book, docId), JSON.stringify({ book, docId, content, savedAt: 1, baseRev: 'sha256:x' }))
}

function makeNode(docId: string, path = `写作/正文/${docId}.md`): TreeNode {
  return { path, name: path.split('/').pop()!, isDirectory: false, role: 'chapter', docId, children: [] } as TreeNode
}

/** 组装章节树动作 composable（deps 用固定书名快照，对齐 ChapterTreePanel 装配形态） */
function setupActions(book: string) {
  return useChapterTreeActions({ bookName: () => book, openError: ref<string | null>(null) })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  treeMock.byPath.clear()
  treeMock.byDocId.clear()
  vi.clearAllMocks()
})

describe('R-P2-1 ① doOpen 404：打开失败清无主镜像', () => {
  it('open 撞 NOT_FOUND（文档已删）→ 镜像清除且错误照旧上抛', async () => {
    putMirror('书A', 'd1', '崩溃残留')
    const doc = useDocStore()
    doc.setBook('书A')
    vi.mocked(getContent).mockRejectedValueOnce(new ApiError('not found', 404, 'NOT_FOUND'))
    await expect(doc.open(makeNode('d1'))).rejects.toThrow('not found')
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull() // 修复点：404 即清孤儿镜像
  })

  it('open 撞非 404 错误（网络/5xx）→ 镜像保留（文档还在，仍是有效兜底）', async () => {
    putMirror('书A', 'd1', '崩溃残留')
    const doc = useDocStore()
    doc.setBook('书A')
    vi.mocked(getContent).mockRejectedValueOnce(new ApiError('boom', 500, 'INTERNAL'))
    await expect(doc.open(makeNode('d1'))).rejects.toThrow('boom')
    expect(localStorage.getItem(KEY('书A', 'd1'))).not.toBeNull()
  })
})

describe('R-P2-1 ② 文档改名：改名成功弃旧键（直接丢弃，不迁移）', () => {
  it('onRenameCommit 成功 → 旧 docId 镜像清除', async () => {
    putMirror('书A', 'd1', '脏编辑')
    treeMock.byPath.set('写作/正文/d1.md', makeNode('d1'))
    vi.mocked(renameDoc).mockResolvedValueOnce({ ok: true, path: '写作/正文/d1-新.md' } as never)
    const actions = setupActions('书A')
    actions.renamePath.value = '写作/正文/d1.md'
    await actions.onRenameCommit('写作/正文/d1.md', '新名')
    expect(vi.mocked(renameDoc)).toHaveBeenCalledWith('书A', 'd1', '新名.md')
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull() // 修复点：改名即弃旧键
  })

  it('onSaveMeta（op=meta 路径同步 rename）成功 → 旧 docId 镜像清除', async () => {
    putMirror('书A', 'd1', '脏编辑')
    const node = makeNode('d1')
    treeMock.byPath.set('写作/正文/d1.md', node)
    treeMock.byDocId.set('d1', makeNode('d1', '写作/正文/0001-新标题.md'))
    vi.mocked(updateChapterMetaDoc).mockResolvedValueOnce({ ok: true, path: '写作/正文/0001-新标题.md' } as never)
    const actions = setupActions('书A')
    actions.onMenuSelect('meta', node)
    await actions.onSaveMeta({ 标题: '新标题', num: 1 })
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull() // 修复点：meta 改名同样弃旧键
  })
})

describe('R-P2-1 ③ 书改名：setBook(新名) 覆盖（表征用例，钉住落点）', () => {
  it('书改名形态（A→B 路由切书）→ 旧书全部镜像清除（含不在内存 doc store 的崩溃残留）', () => {
    // SettingsBook 改名成功 → router.replace(新名) → Book.vue watch → doc.setBook(新名)：
    // 残留镜像不在本次会话内存里（上次会话崩溃残留、本文档从未打开）也须被扫掉
    putMirror('书A', 'd1', '本会话未见过的残留')
    putMirror('书A', 'legacy:设定/旧.md', 'legacy 残留')
    putMirror('书B', 'd1', '他书镜像')
    const doc = useDocStore()
    doc.setBook('书A')
    doc.setBook('书B') // 改名链的到达形态：路由换新名触发
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
    expect(localStorage.getItem(KEY('书A', 'legacy:设定/旧.md'))).toBeNull()
    expect(localStorage.getItem(KEY('书B', 'd1'))).not.toBeNull() // 他书不误伤
  })
})

describe('R-P2-1 ④ 删书交付面：清理单源可脱离当前书独立调用', () => {
  it('clearBookMirrors 导出可用（useShelf.confirmDelete 一行接线的落点）', () => {
    putMirror('书A', 'd1', '待清残留')
    putMirror('书B', 'd1', '他书镜像')
    const doc = useDocStore() // 删书链发生在书架页：无需打开目标书
    doc.clearBookMirrors('书A')
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
    expect(localStorage.getItem(KEY('书B', 'd1'))).not.toBeNull()
  })

  it('clearDirtyMirror 导出可用（docId 级精确删，含 pending 节流一并撤）', async () => {
    vi.useFakeTimers()
    try {
      const doc = useDocStore()
      doc.setBook('书A')
      vi.mocked(getContent).mockResolvedValueOnce('盘上内容')
      await doc.open(makeNode('d1'))
      doc.patch('d1', '本地编辑')
      doc.clearDirtyMirror('书A', 'd1')
      await vi.advanceTimersByTimeAsync(8_000) // pending 节流不得补写
      expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
