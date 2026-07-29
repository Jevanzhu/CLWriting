// @vitest-environment happy-dom
/**
 * workspace store 测试：单文档打开/切换（旧文档 dirty 自动保存）
 * + localStorage 持久化恢复 + validate 失效清空 + 新建信号。
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
  it('openTab 后新实例 setBook 同书 → 恢复 activeDocId', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    // 模拟刷新：新 pinia 实例
    setActivePinia(createPinia())
    const ws2 = useWorkspaceStore()
    ws2.setBook(BOOK)
    expect(ws2.activeDocId).toBe('d1')
  })

  it('setBook 无记录 → 空', () => {
    const ws = useWorkspaceStore()
    ws.setBook('其他书')
    expect(ws.activeDocId).toBeNull()
  })

  it('localStorage 损坏 → 降级空', () => {
    localStorage.setItem('clw2.workspace.bad', '{not json')
    const ws = useWorkspaceStore()
    ws.setBook('bad')
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
