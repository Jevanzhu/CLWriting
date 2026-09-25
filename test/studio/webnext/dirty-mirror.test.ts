// @vitest-environment happy-dom
/**
 * dirty 正文 localStorage 节流镜像（渲染进程硬崩溃兜底）行为族——按行为合并五散落文件
 * （原 r55-f3-dirty-mirror / r57-e1-mirror-freshness / backlog-rp2-1-mirror-cleanup /
 * backlog-rp2-2-mirror-cost / backlog-doc-mirror-key，mock 与夹具同构）。
 *
 * - R55-F-3（五十五轮）三面：① 写侧——dirty/conflict entry 内容节流 ~2s 镜像进
 *   localStorage（key `clw:dirty-mirror:<book>:<docId>`，单条超 2MB 跳过留痕）；
 *   ② 读侧——open 载入时镜像内容 ≠ 服务端内容 → 恢复为当前脏内容（沿用 dirty 语义）
 *   + 一次性 toast；一致则清陈旧镜像；③ 清理——保存成功 / 转 clean / 文档删除 /
 *   切书 setBook 清对应镜像。
 * - R57-E-1（五十七轮）：镜像复活时效门（baseRev 双门）——复活须 mirror.baseRev ===
 *   当前基线（自崩溃点服务端未变过）；陈旧/旧格式镜像只清不复活，防多标签页/外部编辑
 *   场景下陈旧镜像以匹配的 expectedRevision 静默覆盖已保存的新内容。
 * - R-P2-1（评审修复批）：镜像键族清理缺失面收敛——① doOpen 404 清无主孤儿；
 *   ② 文档改名（rename / meta 路径同步 rename）弃旧键（直接丢弃不迁移）；③ 书改名经
 *   切书链 setBook(新名) → clearBookMirrors(旧名) 覆盖（表征用例钉落点）；④ 删书交付面
 *   = doc store 导出清理单源（clearBookMirrors / clearDirtyMirror）供 useShelf 一行接线。
 * - R-P2-2（评审修复批）：镜像峰值开销收敛——① 内容未变不重写（到点值级全等比对跳过
 *   stringify+setItem）；② 按 payload 规模自适应节流间隔（≤256K 2s / >256K 4s / >1M 8s）。
 * - R59 清偿批（R57-E-3）：镜像清理属主精确判定——清理侧读 payload 的 book 字段精确
 *   比对（键内 `:` 不越界，书名含 `:` 不跨书误伤）；损坏键无从判属主保守不删。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const toastMock = vi.hoisted(() => vi.fn())
const getContent = vi.hoisted(() => vi.fn())
const treeMock = vi.hoisted(() => ({
  revision: 'r0',
  grouped: [] as unknown[],
  byPath: new Map<string, import('../../../src/studio/web-next/src/types/tree').TreeNode>(),
  byDocId: new Map<string, import('../../../src/studio/web-next/src/types/tree').TreeNode>(),
  load: vi.fn(async () => {}),
  updateWordCount: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => {
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
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})
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

import { saveContent, renameDoc, updateChapterMetaDoc } from '../../../src/studio/web-next/src/api/documents'
import { ApiError } from '../../../src/studio/web-next/src/api/client'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'
import { sha256Revision } from '../../../src/studio/web-next/src/shared/revision'
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

function makeNode(docId: string, path = `写作/正文/${docId}.md`): TreeNode {
  return { path, name: path.split('/').pop()!, isDirectory: false, role: 'chapter', docId, children: [] } as TreeNode
}

async function openDoc(doc: ReturnType<typeof useDocStore>, docId: string, serverContent: string): Promise<void> {
  vi.mocked(getContent).mockResolvedValueOnce(serverContent)
  await doc.open(makeNode(docId))
}

/** 直接落一条镜像（与 writeDirtyMirror 的 payload 同构；带 baseRev 走可复活形态） */
function putMirror(book: string, docId: string, content: string): void {
  localStorage.setItem(KEY(book, docId), JSON.stringify({ book, docId, content, savedAt: 1, baseRev: 'sha256:x' }))
}

/** setBook 两跳触发 clearBookMirrors(from)——store 未导出该内部函数，走切书路径驱动 */
function leaveBook(from: string): void {
  const doc = useDocStore()
  doc.setBook(from)
  doc.setBook(`${from}#其他书`)
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
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── R55-F-3 ① 写侧：节流镜像 ────────────────────────

describe('R55-F-3 ① 写侧：节流镜像', () => {
  it('patch 置脏后节流 ~2s 落镜像；窗口内连续 patch 合并为最后一版', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    doc.patch('d1', '第一版')
    doc.patch('d1', '第二版')
    // 节流窗口内未落盘（不逐键写 localStorage）
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
    await vi.advanceTimersByTimeAsync(2_000)
    const raw = localStorage.getItem(KEY('书A', 'd1'))
    expect(raw).toBeTruthy()
    const p = JSON.parse(raw!)
    expect(p.book).toBe('书A')
    expect(p.docId).toBe('d1')
    expect(p.content).toBe('第二版') // trailing：只落最后一版
    expect(typeof p.savedAt).toBe('number')
  })

  it('单条镜像超 2MB 上限 → 跳过不写且不抛（防 quota 爆）', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上')
    const dbg = vi.spyOn(console, 'debug').mockImplementation(() => {})
    doc.patch('d1', 'x'.repeat(2_100_000))
    // R-P2-2：>1M 大档节流间隔拉长到 8s——超限跳过语义不变，只随分档推迟到点
    await vi.advanceTimersByTimeAsync(8_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
    expect(dbg).toHaveBeenCalled() // debug 留痕
    dbg.mockRestore()
  })
})

// ── R55-F-3 ② 读侧：open 镜像复活 ────────────────────────

describe('R55-F-3 ② 读侧：open 镜像复活', () => {
  it('镜像内容 ≠ 服务端内容 → 恢复为当前脏内容 + 一次性 toast；基线仍为服务端 revision', async () => {
    // R57-E-1 起镜像带镜像时基线 baseRev：本用例语义 = 自崩溃点服务端未变（baseRev =
    // 当前服务端内容哈希），复活路径照旧
    localStorage.setItem(
      KEY('书A', 'd1'),
      JSON.stringify({
        book: '书A',
        docId: 'd1',
        content: '崩溃前未保存编辑',
        savedAt: 42,
        baseRev: await sha256Revision('盘上内容'),
      }),
    )
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    const e = doc.get('d1')!
    expect(e.content).toBe('崩溃前未保存编辑') // 修复点：镜像内容复活
    expect(e.dirty).toBe(true) // 沿用 dirty 语义（autosave/⌘S 照常接管）
    expect(e.baselineRevision).toBe(await sha256Revision('盘上内容')) // 乐观锁基线不乱
    expect(toastMock).toHaveBeenCalledWith('检测到上次未保存的编辑，已恢复', 'info')
  })

  it('镜像内容与服务端一致（无丢失）→ 不置脏并清陈旧镜像、不 toast', async () => {
    localStorage.setItem(
      KEY('书A', 'd1'),
      JSON.stringify({ book: '书A', docId: 'd1', content: '盘上内容', savedAt: 42 }),
    )
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    const e = doc.get('d1')!
    expect(e.dirty).toBe(false)
    expect(e.content).toBe('盘上内容')
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull() // 陈旧镜像清除
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('损坏镜像（非 JSON）→ 视为不存在，open 照常', async () => {
    localStorage.setItem(KEY('书A', 'd1'), '{oops')
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    expect(doc.get('d1')!.dirty).toBe(false)
    expect(doc.get('d1')!.content).toBe('盘上内容')
  })
})

// ── R57-E-1：镜像复活时效门 ────────────────────────

describe('R57-E-1：镜像复活时效门', () => {
  it('写侧：镜像 payload 记录镜像时的服务端基线 baseRev', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    vi.mocked(getContent).mockResolvedValueOnce('盘上内容')
    await doc.open(makeNode('d1'))
    doc.patch('d1', '本地编辑')
    await vi.advanceTimersByTimeAsync(2_000)
    const p = JSON.parse(localStorage.getItem(KEY('书A', 'd1'))!)
    expect(p.baseRev).toBe(await sha256Revision('盘上内容'))
  })

  it('陈旧镜像（崩溃后服务端被外部更新，baseRev ≠ 当前基线）→ 只清不复活、不 toast', async () => {
    localStorage.setItem(
      KEY('书A', 'd1'),
      JSON.stringify({
        book: '书A',
        docId: 'd1',
        content: '崩溃前的陈旧编辑',
        savedAt: 42,
        baseRev: await sha256Revision('盘上旧内容'), // 镜像时的服务端；此后被外部更新
      }),
    )
    const doc = useDocStore()
    doc.setBook('书A')
    vi.mocked(getContent).mockResolvedValueOnce('盘上新内容') // 外部已保存的新内容
    await doc.open(makeNode('d1'))
    const e = doc.get('d1')!
    // 修复点：服务端新内容原样呈现，不被陈旧镜像静默覆盖
    expect(e.content).toBe('盘上新内容')
    expect(e.dirty).toBe(false)
    expect(e.baselineRevision).toBe(await sha256Revision('盘上新内容'))
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull() // 陈旧镜像清除
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('新鲜镜像（baseRev === 当前基线且内容不同）→ 照常复活 + toast（正常路径不回归）', async () => {
    localStorage.setItem(
      KEY('书A', 'd1'),
      JSON.stringify({
        book: '书A',
        docId: 'd1',
        content: '崩溃前未保存编辑',
        savedAt: 42,
        baseRev: await sha256Revision('盘上内容'), // 自崩溃点服务端未变
      }),
    )
    const doc = useDocStore()
    doc.setBook('书A')
    vi.mocked(getContent).mockResolvedValueOnce('盘上内容')
    await doc.open(makeNode('d1'))
    const e = doc.get('d1')!
    expect(e.content).toBe('崩溃前未保存编辑')
    expect(e.dirty).toBe(true)
    expect(e.baselineRevision).toBe(await sha256Revision('盘上内容'))
    expect(toastMock).toHaveBeenCalledWith('检测到上次未保存的编辑，已恢复', 'info')
  })

  it('旧格式镜像（无 baseRev 字段，升级残留）→ 按陈旧处理：只清不复活', async () => {
    localStorage.setItem(
      KEY('书A', 'd1'),
      JSON.stringify({ book: '书A', docId: 'd1', content: '升级前残留', savedAt: 42 }),
    )
    const doc = useDocStore()
    doc.setBook('书A')
    vi.mocked(getContent).mockResolvedValueOnce('盘上内容')
    await doc.open(makeNode('d1'))
    const e = doc.get('d1')!
    expect(e.content).toBe('盘上内容')
    expect(e.dirty).toBe(false)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
    expect(toastMock).not.toHaveBeenCalled()
  })
})

// ── R55-F-3 ③ 清理时机 ────────────────────────

describe('R55-F-3 ③ 清理时机', () => {
  it('保存成功 → 镜像清除（含 pending 节流）', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上')
    doc.patch('d1', '本地编辑')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeTruthy()
    vi.mocked(saveContent).mockResolvedValueOnce({ ok: true, revision: 'sha256:abc' } as never)
    await doc.save('d1')
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull() // 修复点：落盘即清
    // 后续再无 patch：节流不复活镜像
    await vi.advanceTimersByTimeAsync(10_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
  })

  it('保存 404（文档已删）→ 条目清理且镜像一并清除', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上')
    doc.patch('d1', '本地编辑')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeTruthy()
    vi.mocked(saveContent).mockRejectedValueOnce(new ApiError('not found', 404, 'NOT_FOUND'))
    await doc.save('d1')
    expect(doc.get('d1')).toBeUndefined()
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
  })

  it('冲突重载（丢弃本地）→ 镜像清除', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上')
    doc.patch('d1', '本地')
    doc.get('d1')!.conflict = true
    await vi.advanceTimersByTimeAsync(2_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeTruthy()
    vi.mocked(getContent).mockResolvedValueOnce('远端最新')
    await doc.reloadFromRemote('d1')
    expect(doc.get('d1')!.dirty).toBe(false)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
  })

  it('discard（删除文档）→ 镜像清除', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上')
    doc.patch('d1', '本地')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeTruthy()
    doc.discard('d1')
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
  })

  it('setBook 切书 → 前书全部镜像与 pending 节流清除；他书镜像不受影响', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上')
    doc.patch('d1', '本地')
    localStorage.setItem(KEY('书A', 'd2'), JSON.stringify({ book: '书A', docId: 'd2', content: '残留', savedAt: 1 }))
    localStorage.setItem(KEY('书B', 'd1'), JSON.stringify({ book: '书B', docId: 'd1', content: '他书', savedAt: 1 }))
    doc.setBook('书B')
    await vi.advanceTimersByTimeAsync(5_000) // pending 节流也不得跨书补写
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
    expect(localStorage.getItem(KEY('书A', 'd2'))).toBeNull() // 前书残留清除
    expect(localStorage.getItem(KEY('书B', 'd1'))).not.toBeNull() // 他书不误伤
  })
})

// ── R-P2-1：清理缺失面收敛 ────────────────────────

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
    const doc = useDocStore()
    doc.setBook('书A')
    vi.mocked(getContent).mockResolvedValueOnce('盘上内容')
    await doc.open(makeNode('d1'))
    doc.patch('d1', '本地编辑')
    doc.clearDirtyMirror('书A', 'd1')
    await vi.advanceTimersByTimeAsync(8_000) // pending 节流不得补写
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
  })
})

// ── R-P2-2：峰值开销收敛 ────────────────────────

describe('R-P2-2 ② 按 payload 规模自适应节流间隔', () => {
  it('小文档（≤256K）维持 2s 节拍不回归', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    doc.patch('d1', '小文档编辑')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).not.toBeNull()
  })

  it('中档（>256K ≤1M）：2s 不落盘、4s 落盘', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    doc.patch('d1', 'y'.repeat(300_000))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull() // 修复点：不再 2s 高频拍
    await vi.advanceTimersByTimeAsync(2_000)
    const p = JSON.parse(localStorage.getItem(KEY('书A', 'd1'))!)
    expect(p.content).toHaveLength(300_000)
  })

  it('大档（>1M）：2s/4s 均不落盘、8s 落盘（峰值拍频减半再减半）', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    doc.patch('d1', 'x'.repeat(1_100_000)) // payload < MIRROR_MAX_CHARS（2M），仍可镜像
    await vi.advanceTimersByTimeAsync(4_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull() // 修复点：2s/4s 档均不拍
    await vi.advanceTimersByTimeAsync(4_000)
    const p = JSON.parse(localStorage.getItem(KEY('书A', 'd1'))!)
    expect(p.content).toHaveLength(1_100_000)
  })
})

describe('R-P2-2 ① 内容未变不重写', () => {
  it('净零编辑（改了又改回）→ 到点全等命中跳过 stringify+setItem，镜像不重写', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    const setSpy = vi.spyOn(localStorage, 'setItem')
    doc.patch('d1', 'v1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(setSpy).toHaveBeenCalledTimes(1) // 首拍照常落镜像
    // 净零编辑：调度面允许（每次 patch 都变了才调度），但到点内容已回到上次镜像值
    doc.patch('d1', 'v2')
    doc.patch('d1', 'v1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(setSpy).toHaveBeenCalledTimes(1) // 修复点：值级全等 → 跳过重写
    expect((JSON.parse(localStorage.getItem(KEY('书A', 'd1'))!) as { content: string }).content).toBe('v1')
    setSpy.mockRestore()
  })

  it('内容真变 → 照常重写（跳过优化不误伤正常镜像更新）', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    doc.patch('d1', 'v1')
    await vi.advanceTimersByTimeAsync(2_000)
    doc.patch('d1', 'v2') // 真编辑
    await vi.advanceTimersByTimeAsync(2_000)
    expect((JSON.parse(localStorage.getItem(KEY('书A', 'd1'))!) as { content: string }).content).toBe('v2')
  })
})

// ── R59 清偿批（R57-E-3）：镜像清理属主判定 ────────────────────────

describe('R59 清偿批（R57-E-3）：镜像清理属主判定', () => {
  it('含 `:` 书名不跨书误伤：清《A》只删 A 的镜像，《A:B》的镜像保留（修复前前缀越界连删）', () => {
    putMirror('A', 'd1', '本书镜像')
    putMirror('A:B', 'x', '他书镜像') // 裸前缀 `clw:dirty-mirror:A:` 会越界命中此键
    leaveBook('A')
    expect(localStorage.getItem(KEY('A', 'd1'))).toBeNull() // 本书镜像照常清
    expect(localStorage.getItem(KEY('A:B', 'x'))).not.toBeNull() // 修复点：不跨书误伤
  })

  it('正常书名清理不回归：前书镜像全清、他书镜像不受影响', () => {
    putMirror('书A', 'd1', '前书镜像')
    putMirror('书B', 'd1', '他书镜像')
    leaveBook('书A')
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
    expect(localStorage.getItem(KEY('书B', 'd1'))).not.toBeNull()
  })

  it('legacy docId（含 `:`）仍随属主书一起清（按 payload 判属主不受 docId 内分隔符干扰）', () => {
    putMirror('A', 'legacy:设定/旧.md', 'legacy 脏编辑')
    putMirror('A:B', 'x', '他书镜像')
    leaveBook('A')
    expect(localStorage.getItem(KEY('A', 'legacy:设定/旧.md'))).toBeNull()
    expect(localStorage.getItem(KEY('A:B', 'x'))).not.toBeNull()
  })

  it('损坏镜像（非 JSON）无从判属主 → 保守不删（readDirtyMirror 同样拒读，无复活面）', () => {
    localStorage.setItem(KEY('A', 'corrupt'), '{oops')
    leaveBook('A')
    expect(localStorage.getItem(KEY('A', 'corrupt'))).not.toBeNull()
  })
})
