// @vitest-environment happy-dom
/**
 * R61-F-1（P3）回归：切书窗口内旧书 prefs 加载失败会清掉新书的书级覆盖。
 *
 * loadBookPrefs 的 catch 分支（R33-75「清残留」语义）缺切书代际守卫——A 书
 * getBookPrefs 挂起窗内已切到 B 书（B 成功加载回填 bookPageWidth/bookAutosaveInterval）
 * 时，A 的迟到 reject 走 catch 把 B 刚回填的书级覆盖清成 null 并 apply()。「清残留」
 * 只对当前书成立，补 `if (gen !== bookGen) return`（对齐 try 成功路径同款 gen 守卫）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// flush：让 setBook 的异步 loadBookPrefs + debounce 500ms persist 落定
const flush = () => vi.advanceTimersByTimeAsync(600)
import { createPinia, setActivePinia } from 'pinia'

// doc store mock（workspace.test.ts 同款；本组用例不触 doc 行为，仅隔 import 面）
const { docGet, docSave } = vi.hoisted(() => ({
  docGet: vi.fn(),
  docSave: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: () => ({ get: docGet, save: docSave }),
}))

// prefs API mock：内存 Map 模拟书级 prefs 持久化（workspace.test.ts 口径）；
// 首调用可用 mockImplementationOnce 换成手动挂起/拒绝的 Promise。
const { bookPrefs } = vi.hoisted(() => ({
  bookPrefs: new Map<string, Record<string, unknown>>(),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: vi.fn(async (name: string) => ({ ...(bookPrefs.get(name) ?? {}) })),
  putBookPrefs: vi.fn(async (name: string, data: Record<string, unknown>) => {
    bookPrefs.set(name, { ...data })
  }),
}))

import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'
import { getBookPrefs } from '../../../src/studio/web-next/src/api/prefs'

// happy-dom localStorage 在 vitest 集成下缺 clear()，Map-backed 替身（照 workspace.test.ts）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
const localStorageMock = createLocalStorage()
vi.stubGlobal('localStorage', localStorageMock)

beforeEach(() => {
  vi.useFakeTimers()
  localStorageMock.clear()
  bookPrefs.clear()
  setActivePinia(createPinia())
  docGet.mockReturnValue(undefined)
  docSave.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('R61-F-1: 切书窗内旧书 prefs 迟到失败不清新书书级覆盖', () => {
  it('A 挂起 → 切 B 成功回填 → A 迟到 reject → B 的 bookPageWidth/bookAutosaveInterval 不被清', async () => {
    bookPrefs.set('book-b', { pageWidth: 800, autosaveInterval: 45 })
    let rejectA!: (e: unknown) => void
    vi.mocked(getBookPrefs).mockImplementationOnce(
      () => new Promise<Record<string, unknown>>((_res, rej) => { rejectA = rej }),
    )
    const ws = useWorkspaceStore()
    const ps = usePrefsStore()
    ws.setBook('book-a') // A 的 getBookPrefs 挂起（gen=1）
    ws.setBook('book-b') // 切书 gen=2；B 走默认实现成功加载回填
    await flush()
    expect(ps.bookPageWidth).toBe(800) // B 回填到位（前置确认）
    expect(ps.bookAutosaveInterval).toBe(45)

    rejectA(new Error('A 书 prefs 迟到失败'))
    await flush()
    // 修复点：catch 分支无 gen 守卫（修复前）会把 B 刚回填的书级覆盖清成 null
    expect(ps.bookPageWidth).toBe(800)
    expect(ps.bookAutosaveInterval).toBe(45)
  })

  it('同书加载失败仍清残留 + apply（R33-75 语义不回归：守卫不误伤当前书路径）', async () => {
    const ws = useWorkspaceStore()
    const ps = usePrefsStore()
    ps.bookPageWidth = 777
    ps.bookAutosaveInterval = 9
    vi.mocked(getBookPrefs).mockRejectedValueOnce(new Error('API 不可达'))
    ws.setBook('book-c') // 无切书竞态：reject 落定时 bookGen 未变
    await flush()
    expect(ps.bookPageWidth).toBeNull()
    expect(ps.bookAutosaveInterval).toBeNull()
  })
})
