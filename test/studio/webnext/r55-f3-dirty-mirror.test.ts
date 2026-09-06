// @vitest-environment happy-dom
/**
 * R55-F-3（五十五轮）回归：dirty 正文的 localStorage 节流镜像（渲染进程硬崩溃兜底）。
 *
 * 现状：docs 仅内存 Map，autosave 默认 30s（下限 5s），crash/OOM/kill -9 时
 * 「上次保存→崩溃」窗口内的键入无声丢失。修复三面：
 * ① 写侧——dirty/conflict entry 内容节流 ~2s 镜像进 localStorage（key
 *    `clw:dirty-mirror:<book>:<docId>`，单条超 2MB 跳过留痕）；
 * ② 读侧——open 载入时镜像内容 ≠ 服务端内容 → 恢复为当前脏内容（沿用 dirty 语义）
 *    + 一次性 toast；镜像与服务端一致则清陈旧镜像；
 * ③ 清理——保存成功 / 转 clean / 文档删除 / 切书 setBook 清对应镜像。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const toastMock = vi.hoisted(() => vi.fn())
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
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: () => ({ toast: toastMock }),
}))
vi.mock('../../../src/studio/web-next/src/stores/words', () => ({
  useWordsStore: () => ({ ensureBaseline: vi.fn(async () => {}) }),
}))

import { getContent, saveContent } from '../../../src/studio/web-next/src/api/documents'
import { ApiError } from '../../../src/studio/web-next/src/api/client'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
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
/** 泵微任务（crypto.subtle digest 等）——预留排宏任务用，当前用例经 vi 推进即覆盖 */
async function _pump(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

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
    await vi.advanceTimersByTimeAsync(2_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull()
    expect(dbg).toHaveBeenCalled() // debug 留痕
    dbg.mockRestore()
  })
})

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
