// @vitest-environment happy-dom
/**
 * R59 清偿批（R57-E-3）回归：dirty 镜像清理的属主精确判定。
 *
 * 现状：clearBookMirrors 以裸前缀 `clw:dirty-mirror:<book>:` 扫描删除，而 `:` 同时是
 * 键内书名与 docId 的分隔符——书名含 `:`（mac/linux 目录名合法）时前缀越界：清《A》
 * 会把《A:B》的镜像一并删掉（跨书误伤）。
 * 修复：清理侧改读镜像 payload 的 book 字段精确比对（payload 自 R55-F-3 首版即含
 * book+docId，全量既有镜像兼容，无需迁移）；解析失败的损坏键无从判属主，保守不删
 * （readDirtyMirror 同样拒读，无复活面）。键格式不变，读写两侧零迁移。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

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
  useUiStore: () => ({ toast: vi.fn() }),
}))
vi.mock('../../../src/studio/web-next/src/stores/words', () => ({
  useWordsStore: () => ({ ensureBaseline: vi.fn(async () => {}) }),
}))

import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'

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

/** 直接落一条镜像（与 writeDirtyMirror 的 payload 同构；清理侧属主判定只读 book 字段） */
function putMirror(book: string, docId: string, content: string): void {
  localStorage.setItem(KEY(book, docId), JSON.stringify({ book, docId, content, savedAt: 1 }))
}

/** setBook 两跳触发 clearBookMirrors(from)——store 未导出该内部函数，走切书路径驱动 */
function leaveBook(from: string): void {
  const doc = useDocStore()
  doc.setBook(from)
  doc.setBook(`${from}#其他书`)
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
})
// 不 unstubAllGlobals：localStorage 替身是模块级桩（r55-f3 同款），unstub 会退化回
// happy-dom 原生 localStorage（缺 clear()/length）伤及后续用例

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
