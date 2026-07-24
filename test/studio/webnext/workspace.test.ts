// @vitest-environment happy-dom
/**
 * workspace store 测试（T4.4 第二批）：tabs 增删切换 + localStorage 持久化恢复
 * + validate 失效剔除 + 关 dirty tab 三选（联动 doc store）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// doc store 用 hoisted mock：不同用例控制 get(dirty)/save(成败)
const { docGet, docSave } = vi.hoisted(() => ({
  docGet: vi.fn(),
  docSave: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: () => ({ get: docGet, save: docSave }),
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
  localStorageMock.clear()
  setActivePinia(createPinia())
  docGet.mockReturnValue(undefined)
  docSave.mockReset()
})

describe('workspace · tabs 增删切换', () => {
  it('openTab 新 doc → 新 tab + active + 回编辑器视图', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.setActiveView('workbench')
    ws.openTab('d1')
    expect(ws.tabs).toHaveLength(1)
    expect(ws.activeDocId).toBe('d1')
    expect(ws.activeView).toBe('editor')
  })

  it('openTab 已开 doc → 切 active 不新增', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    ws.openTab('d2')
    ws.openTab('d1')
    expect(ws.tabs).toHaveLength(2)
    expect(ws.activeDocId).toBe('d1')
  })

  it('closeTab 关中间 active → 转移到下一个', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    ws.openTab('d2')
    ws.openTab('d3')
    ws.activateTab(ws.tabs[1].id)
    ws.closeTab(ws.tabs[1].id)
    expect(ws.tabs.map((t) => t.docId)).toEqual(['d1', 'd3'])
    expect(ws.activeDocId).toBe('d3')
  })

  it('closeTab 关末尾 active → 回退前一个', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    ws.openTab('d2')
    ws.closeTab(ws.tabs[1].id)
    expect(ws.activeDocId).toBe('d1')
  })

  it('closeTab 全关 → active null', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    ws.closeTab(ws.tabs[0].id)
    expect(ws.activeTabId).toBeNull()
  })
})

describe('workspace · 持久化与恢复', () => {
  it('openTab 后新实例 setBook 同书 → 恢复 tabs + active', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    ws.openTab('d2')
    const activeBefore = ws.activeTabId
    // 模拟刷新：新 pinia 实例
    setActivePinia(createPinia())
    const ws2 = useWorkspaceStore()
    ws2.setBook(BOOK)
    expect(ws2.tabs.map((t) => t.docId)).toEqual(['d1', 'd2'])
    expect(ws2.activeTabId).toBe(activeBefore)
  })

  it('setBook 无记录 → 空', () => {
    const ws = useWorkspaceStore()
    ws.setBook('其他书')
    expect(ws.tabs).toHaveLength(0)
    expect(ws.activeTabId).toBeNull()
  })

  it('localStorage 损坏 → 降级空', () => {
    localStorage.setItem('clw2.workspace.bad', '{not json')
    const ws = useWorkspaceStore()
    ws.setBook('bad')
    expect(ws.tabs).toHaveLength(0)
  })
})

describe('workspace · validate 失效剔除', () => {
  it('失效 docId 剔除 + active 失效转第一个', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    ws.openTab('d2')
    ws.openTab('d3')
    ws.activateTab(ws.tabs[2].id) // d3 active
    ws.validate(new Set(['d1', 'd2'])) // d3 失效
    expect(ws.tabs.map((t) => t.docId)).toEqual(['d1', 'd2'])
    expect(ws.activeDocId).toBe('d1')
  })

  it('全部有效 → 不变', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    ws.openTab('d2')
    ws.validate(new Set(['d1', 'd2']))
    expect(ws.tabs).toHaveLength(2)
  })
})

describe('workspace · 关 dirty tab 三选', () => {
  it('requestClose 非 dirty → 直关，不 pending', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue(undefined)
    ws.requestClose(ws.tabs[0].id)
    expect(ws.pendingCloseTabId).toBeNull()
    expect(ws.tabs).toHaveLength(0)
  })

  it('requestClose dirty → pendingCloseTabId', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true })
    ws.requestClose(ws.tabs[0].id)
    expect(ws.pendingCloseTabId).toBe(ws.tabs[0].id)
    expect(ws.tabs).toHaveLength(1)
  })

  it('confirmDiscard → 关', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true })
    ws.requestClose(ws.tabs[0].id)
    ws.confirmDiscard()
    expect(ws.tabs).toHaveLength(0)
    expect(ws.pendingCloseTabId).toBeNull()
  })

  it('cancelClose → 不关', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true })
    ws.requestClose(ws.tabs[0].id)
    ws.cancelClose()
    expect(ws.tabs).toHaveLength(1)
    expect(ws.pendingCloseTabId).toBeNull()
  })

  it('confirmSaveAndClose save 成功 → 关', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true })
    ws.requestClose(ws.tabs[0].id)
    docSave.mockResolvedValue(true)
    await ws.confirmSaveAndClose()
    expect(ws.tabs).toHaveLength(0)
  })

  it('confirmSaveAndClose save 失败 → 不关（保留待办）', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true })
    ws.requestClose(ws.tabs[0].id)
    docSave.mockResolvedValue(false)
    await ws.confirmSaveAndClose()
    expect(ws.tabs).toHaveLength(1)
  })
})
