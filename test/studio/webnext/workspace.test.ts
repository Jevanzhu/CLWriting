// @vitest-environment happy-dom
/**
 * workspace store 测试：单文档打开/切换（旧文档 dirty 自动保存）
 * + localStorage 持久化恢复 + validate 失效清空 + 新建信号。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// flush：让 setBook 的异步 loadBookPrefs + debounce 500ms persist 落定
const flush = () => vi.advanceTimersByTimeAsync(600)
import { createPinia, setActivePinia } from 'pinia'

// doc store 用 hoisted mock：不同用例控制 get(dirty)/save(成败)
const { docGet, docSave } = vi.hoisted(() => ({
  docGet: vi.fn(),
  docSave: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: () => ({ get: docGet, save: docSave }),
}))

// prefs API mock：内存 Map 模拟书级 prefs 持久化（配置重构后 localStorage → API）
const { bookPrefs } = vi.hoisted(() => ({
  bookPrefs: new Map<string, Record<string, unknown>>(),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: vi.fn(async (name: string) => ({ ...(bookPrefs.get(name) ?? {}) })),
  putBookPrefs: vi.fn(async (name: string, data: Record<string, unknown>) => {
    bookPrefs.set(name, { ...data })
  }),
  usePrefsStore: () => ({
    bookPageWidth: null,
    bookAutosaveInterval: null,
    apply: () => {},
  }),
}))

import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

const BOOK = 'test-book'

// happy-dom localStorage 在 vitest 集成下缺 clear()，提供一个完整 Map-backed 替身
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

describe('workspace · 单文档打开切换', () => {
  it('openTab → activeDocId + 回编辑器视图', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.setActiveView('workbench')
    ws.openTab('d1')
    expect(ws.activeDocId).toBe('d1')
    expect(ws.activeView).toBe('editor')
  })

  it('openTab 切换 → 覆盖 activeDocId（不累积）', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    ws.openTab('d2')
    expect(ws.activeDocId).toBe('d2')
  })

  it('切换时旧文档 dirty → 静默自动保存', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true })
    ws.openTab('d2')
    expect(docSave).toHaveBeenCalledWith('d1', 'autosave')
    expect(ws.activeDocId).toBe('d2')
  })

  it('旧文档非 dirty → 不保存', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: false })
    ws.openTab('d2')
    expect(docSave).not.toHaveBeenCalled()
  })

  it('重开同一文档 → 不触发保存', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true })
    ws.openTab('d1')
    expect(docSave).not.toHaveBeenCalled()
    expect(ws.activeDocId).toBe('d1')
  })
})

describe('workspace · 持久化与恢复', () => {
  it('openTab 后新实例 setBook 同书 → 恢复 activeDocId', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    await flush()
    ws.openTab('d1')
    await flush() // 等 debounce persist 写回 prefs
    // 模拟刷新：新 pinia 实例
    setActivePinia(createPinia())
    const ws2 = useWorkspaceStore()
    ws2.setBook(BOOK)
    await flush()
    expect(ws2.activeDocId).toBe('d1')
  })

  it('setBook 无记录 → 空', async () => {
    const ws = useWorkspaceStore()
    ws.setBook('其他书')
    await flush()
    expect(ws.activeDocId).toBeNull()
  })

  it('localStorage 损坏 → 降级空', async () => {
    localStorage.setItem('clw2.workspace.bad', '{not json')
    const ws = useWorkspaceStore()
    ws.setBook('bad')
    await flush()
    expect(ws.activeDocId).toBeNull()
  })
})

describe('workspace · validate 失效清空', () => {
  it('activeDocId 失效 → 清空', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d3')
    ws.validate(new Set(['d1', 'd2']))
    expect(ws.activeDocId).toBeNull()
  })

  it('activeDocId 有效 → 不变', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    ws.validate(new Set(['d1', 'd2']))
    expect(ws.activeDocId).toBe('d1')
  })
})

describe('workspace · 新建信号', () => {
  it('triggerCreate 默认正文 → kind=chapter + tick 递增', () => {
    const ws = useWorkspaceStore()
    const before = ws.createTick
    ws.triggerCreate()
    expect(ws.createKind).toBe('chapter')
    expect(ws.createTick).toBe(before + 1)
  })

  it('triggerCreate 指定类型 → kind 更新，连续触发 tick 累加', () => {
    const ws = useWorkspaceStore()
    ws.triggerCreate('character')
    expect(ws.createKind).toBe('character')
    const t1 = ws.createTick
    ws.triggerCreate('worldview')
    expect(ws.createKind).toBe('worldview')
    expect(ws.createTick).toBe(t1 + 1)
  })
})

describe('workspace · 切书 debounce 竞态（ff 细节#11）', () => {
  it('500ms 内切书 → 挂起的 A 书落盘作废，不污染 B 书 prefs', async () => {
    const ws = useWorkspaceStore()
    ws.setBook('book-a')
    await flush() // A 书 prefs 加载完成 + watch 挂上
    ws.openTab('doc-a') // 触发 watch → 排定 500ms 后写 A 书 prefs
    ws.setBook('book-b') // 500ms 内切走（prefsLoaded=false + bookGen++）
    await flush() // 挂起定时器 fire
    // A 书的 activeDocId 不得写进 B 书（修复前：setTimeout 回调 fire 时读 bookName.value='book-b'）
    expect(bookPrefs.get('book-b') ?? {}).not.toMatchObject({ activeDocId: 'doc-a' })
    expect(bookPrefs.has('book-a')).toBe(false) // A 书也无残留写（切书即作废本次落盘）
  })

  it('不切书 → debounce 正常落盘（守卫不误伤常规路径）', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    await flush()
    ws.openTab('d9')
    await flush()
    expect(bookPrefs.get(BOOK)).toMatchObject({ activeDocId: 'd9' })
  })
})
