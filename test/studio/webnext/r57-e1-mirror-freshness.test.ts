// @vitest-environment happy-dom
/**
 * R57-E-1（五十七轮）回归：dirty 镜像复活的时效校验（baseRev 双门）。
 *
 * 修复前复活判据仅 `mirror.content !== content`——崩溃残留镜像 M 与重开后服务端内容
 * N 不同即恢复 M 为 dirty 且基线 = hash(N)：崩溃后同文档被另一存活标签页/外部编辑器
 * 更新过（多标签页为受支持场景）时，陈旧 M 会在 autosave 以匹配的 expectedRevision
 * 静默覆盖已保存的 N（保存零冲突、toast 反报「已恢复」）。
 * 修复：镜像 payload 增存镜像时的服务端基线 baseRev；复活须 mirror.baseRev === 当前
 * 基线（自崩溃点服务端未变过）才许复活，失配/旧格式镜像（无 baseRev 的升级残留）只
 * 清不复活。mock 与夹具沿用 r55-f3-dirty-mirror.test.ts 惯例。
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

import { getContent } from '../../../src/studio/web-next/src/api/documents'
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

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

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
