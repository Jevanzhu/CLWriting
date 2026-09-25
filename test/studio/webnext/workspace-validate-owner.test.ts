// @vitest-environment happy-dom
/**
 * R59 清偿批（R55-F-4 / R55-F-9）回归：workspace store。
 *
 * F-4：validate 以整树 keyset 校验 activeDocId 却无书名属主 scope——切书窗内 tree 仍持
 * 旧书键集（byDocId/ownerBook 与 bookName 更不同窗，R35-10），新书刚恢复的 activeDocId
 * 不在旧键集内被误清（恢复文档被清，下次进书不再恢复；无内容丢失，体验面）。修复：
 * validate 增补 ownerBook 属主参数，键集属他书时跳过校验；Book.vue 调用面把
 * tree.ownerBook 随行传入并纳入 watch 源（新书树归位时补一次属主匹配的校验，
 * R33-72 语义在属主门后照常生效）。
 *
 * F-9：loadBookPrefs 对 pageWidth/autosaveInterval 只验 typeof number 不验正数有限——
 * 0/负数/Infinity（服务端 JSON 可表达 1e999→Infinity；手改 prefs.json 可得 0/负数）
 * 直注 prefs store 书级覆盖（autosave 零/负间隔此前仅靠 Book.vue max(5,·) 事后兜底，
 * pageWidth 非法值直产非法 CSS 宽度）。修复：对齐 stores/prefs 迁移侧
 * Number.isFinite(v) && v > 0 先例，非法值按「无书级覆盖」（null，全局值托底）处理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// flush：让 setBook 的异步 loadBookPrefs + debounce 500ms persist 落定（workspace.test.ts 同款）
const flush = () => vi.advanceTimersByTimeAsync(600)
import { createPinia, setActivePinia } from 'pinia'

// doc store 用 hoisted mock（workspace.test.ts 同款口径）
const { docGet, docSave } = vi.hoisted(() => ({
  docGet: vi.fn(),
  docSave: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: () => ({ get: docGet, save: docSave }),
}))

// prefs API mock：内存 Map 模拟书级 prefs 持久化（workspace.test.ts 同款）；
// getGlobalPrefs/putGlobalPrefs 一并给出（stores/prefs 顶层 import 的具名导出面）
const { bookPrefs } = vi.hoisted(() => ({
  bookPrefs: new Map<string, Record<string, unknown>>(),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: vi.fn(async (name: string) => ({ ...(bookPrefs.get(name) ?? {}) })),
  putBookPrefs: vi.fn(async (name: string, data: Record<string, unknown>) => {
    bookPrefs.set(name, { ...data })
  }),
  getGlobalPrefs: vi.fn(async () => ({})),
  putGlobalPrefs: vi.fn(async () => ({ revision: 1 })),
}))

import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { usePrefsStore } from '../../../src/studio/web-next/src/stores/prefs'

// happy-dom localStorage 在 vitest 集成下缺 clear()，Map-backed 替身（workspace.test.ts 同款）
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

describe('R59 清偿批（R55-F-4）：validate 属主校验', () => {
  it('keyset 属他书（切书窗内旧树滞留）→ 不清本书恢复的 activeDocId（修复前误清）', async () => {
    const ws = useWorkspaceStore()
    ws.setBook('B书')
    await flush()
    ws.openTab('d-b') // B 书刚恢复/打开的文档
    // 切书窗内 tree 仍持 A 书键集（ownerBook='A书' ≠ 当前 bookName 'B书'）
    ws.validate(new Set(['d-a1', 'd-a2']), 'A书')
    expect(ws.activeDocId).toBe('d-b') // 修复点：不以他书键集误清（修复前清 null）
  })

  it('keyset 属本书 → 照常校验清失效 id（R33-72 语义不回归）', async () => {
    const ws = useWorkspaceStore()
    ws.setBook('B书')
    await flush()
    ws.openTab('d-b')
    ws.validate(new Set(['d-x', 'd-y']), 'B书')
    expect(ws.activeDocId).toBeNull()
  })

  it('不传 ownerBook（既有调用面/存量测试口径）→ 维持原行为', () => {
    const ws = useWorkspaceStore()
    ws.setBook('B书')
    ws.openTab('d-b')
    ws.validate(new Set(['d-x']))
    expect(ws.activeDocId).toBeNull()
    ws.openTab('d-b')
    ws.validate(new Set(['d-b']))
    expect(ws.activeDocId).toBe('d-b')
  })
})

describe('R59 清偿批（R55-F-9）：loadBookPrefs 书级覆盖正数守卫', () => {
  it('pageWidth/autosaveInterval 为 0/负数/Infinity → 不注入书级覆盖（null，全局值托底）', async () => {
    bookPrefs.set('B1', { pageWidth: 0, autosaveInterval: -3 })
    bookPrefs.set('B2', { pageWidth: Number('1e999') }) // Infinity：可经服务端 JSON 1e999 到达
    const ws = useWorkspaceStore()
    ws.setBook('B1')
    await flush()
    const ps = usePrefsStore()
    expect(ps.bookPageWidth).toBeNull() // 修复前注入 0
    expect(ps.bookAutosaveInterval).toBeNull() // 修复前注入 -3
    ws.setBook('B2')
    await flush()
    expect(ps.bookPageWidth).toBeNull() // 修复前注入 Infinity
  })

  it('正数有限值照常注入（不误伤常规路径）', async () => {
    bookPrefs.set('B1', { pageWidth: 620, autosaveInterval: 10 })
    const ws = useWorkspaceStore()
    ws.setBook('B1')
    await flush()
    const ps = usePrefsStore()
    expect(ps.bookPageWidth).toBe(620)
    expect(ps.bookAutosaveInterval).toBe(10)
  })
})
