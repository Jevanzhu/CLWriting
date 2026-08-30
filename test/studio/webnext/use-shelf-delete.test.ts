/**
 * R65-54（十三轮批 E-6）回归：useShelf.confirmDelete 成功后 onDeleted 回调。
 * ShelfModal 借它在「删掉当前打开的书」时导航离开死路由 /book/:name——
 * 回调契约：成功（全部删完）必调且带全量名单；失败不调（保留弹窗重试语义）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  deleteBook: vi.fn(),
  clearFalsePositiveMarks: vi.fn(),
  shelfLoad: vi.fn(async () => {}),
}))
vi.mock('../../../src/studio/web-next/src/api/shelf', () => ({ deleteBook: mocks.deleteBook }))
vi.mock('../../../src/studio/web-next/src/stores/check', () => ({ clearFalsePositiveMarks: mocks.clearFalsePositiveMarks }))
vi.mock('../../../src/studio/web-next/src/stores/shelf', () => ({
  useShelfStore: vi.fn(() => ({ books: [], load: mocks.shelfLoad })),
}))
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: vi.fn(() => ({ shelfView: 'grid', setShelfView: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  apiJson: vi.fn(),
  // R27-79 起 404 语义分支用到（useShelf catch 里 e instanceof ApiError）。
  // R28-1（二十八轮）：构造器镜像真实签名 (message, status, code?)（client.ts:14
  // 由构造器赋值 status/code）——替身语义对齐后，用例不再手工补赋值
  ApiError: class ApiError extends Error {
    status?: number
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.status = status
      this.code = code
    }
  },
}))

import { ApiError } from '../../../src/studio/web-next/src/api/client'
import { useShelf } from '../../../src/studio/web-next/src/composables/useShelf'
import { treeFirstOpenKey } from '../../../src/studio/web-next/src/shared/storage-keys'

// R27-79：localStorage 键清扫断言用（node 环境默认无 localStorage，Map 替身照
// r66-frontend-guards 范型；loadSortPreference 的 try/catch 对缺 API 本就兼容）
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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.shelfLoad.mockClear()
})

describe('useShelf: confirmDelete onDeleted 回调（R65-54）', () => {
  it('删除成功 → onDeleted 带全量名单（外壳导航离开死路由的钩子）', async () => {
    mocks.deleteBook.mockResolvedValue(undefined)
    const onDeleted = vi.fn()
    const s = useShelf({ onDeleted })
    s.requestDelete(['书A', '书B'])
    await s.confirmDelete()
    expect(mocks.deleteBook).toHaveBeenCalledTimes(2)
    expect(onDeleted).toHaveBeenCalledTimes(1)
    expect(onDeleted).toHaveBeenCalledWith(['书A', '书B'])
  })

  it('删除失败 → onDeleted 不调（部分删除的外壳导航不该发生，弹窗保留可重试）', async () => {
    mocks.deleteBook.mockRejectedValueOnce(new Error('server 500'))
    const onDeleted = vi.fn()
    const s = useShelf({ onDeleted })
    s.requestDelete(['书A'])
    await s.confirmDelete()
    expect(s.deleteError.value).toBeTruthy()
    expect(s.confirmTarget.value).toEqual(['书A']) // 弹窗保留
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('未传 onDeleted → 不炸（Shelf.vue 全屏页无当前书语境，不守卫）', async () => {
    mocks.deleteBook.mockResolvedValue(undefined)
    const s = useShelf()
    s.requestDelete(['书A'])
    await expect(s.confirmDelete()).resolves.toBeUndefined()
    expect(s.batchMode.value).toBe(false)
  })
})

// ── R27-79（二十七轮）：删书连带清该书 localStorage 残留键 ──

describe('useShelf: 删书清 localStorage 键（R27-79）', () => {
  /**
   * R28-3（二十八轮）：首开键改从单一事实源 shared/storage-keys 拼键（点号形态）——
   * 原 seedKeys 硬编码冒号形态与实现同错互相掩蔽（测试绿而真实写入键清不掉）；
   * 梗概键对齐 OnboardPremise.vue 内局部 PREMISE_KEY（该常量不可导入，按同款拼法）
   */
  function seedKeys(name: string): void {
    localStorage.setItem(`clwriting:onboard-premise:${name}`, `${name}的旧梗概`)
    localStorage.setItem(treeFirstOpenKey(name), '1')
  }

  it('删除成功 → 清该书两键；他书键与无关键保留', async () => {
    seedKeys('书A')
    seedKeys('书B')
    localStorage.setItem('clw-shelf-sort', 'name') // 无关书键（排序偏好）不得误伤
    mocks.deleteBook.mockResolvedValue(undefined)
    const s = useShelf()
    s.requestDelete(['书A'])
    await s.confirmDelete()
    expect(localStorage.getItem('clwriting:onboard-premise:书A')).toBeNull()
    expect(localStorage.getItem(treeFirstOpenKey('书A'))).toBeNull()
    expect(localStorage.getItem('clwriting:onboard-premise:书B')).toBe('书B的旧梗概')
    expect(localStorage.getItem(treeFirstOpenKey('书B'))).toBe('1')
    expect(localStorage.getItem('clw-shelf-sort')).toBe('name')
  })

  it('404 视为已删 → 同样清键（同名重建书不继承旧梗概）', async () => {
    seedKeys('书A')
    // R28-1（二十八轮）：status/code 由构造器赋值（真实签名 (message, status, code?)）
    const e = new ApiError('not found', 404, 'NOT_FOUND')
    mocks.deleteBook.mockRejectedValue(e)
    const s = useShelf()
    s.requestDelete(['书A'])
    await s.confirmDelete()
    expect(localStorage.getItem('clwriting:onboard-premise:书A')).toBeNull()
    expect(localStorage.getItem(treeFirstOpenKey('书A'))).toBeNull()
  })

  it('删除失败（非 404）→ 键保留（书未删成，梗概/首开态不能丢）', async () => {
    seedKeys('书A')
    mocks.deleteBook.mockRejectedValue(new Error('server 500'))
    const s = useShelf()
    s.requestDelete(['书A'])
    await s.confirmDelete()
    expect(s.deleteError.value).toBeTruthy()
    expect(localStorage.getItem('clwriting:onboard-premise:书A')).toBe('书A的旧梗概')
    expect(localStorage.getItem(treeFirstOpenKey('书A'))).toBe('1')
  })

  // R28-3（二十八轮）反证断言：清除键必须与写入方同源（点号形态）。修复前 useShelf
  // 硬编码冒号形态，写入方（点号）键永远清不掉——此用例在修复前必红，防回退错向；
  // 历史冒号形态并非任何写入方产物，清扫不得越权误删（只清精确同源键）
  it('清除键与写入方同源 → 点号键被清，冒号形态无关键不被误删', async () => {
    localStorage.setItem(treeFirstOpenKey('书A'), '1') // 写入方形态（点号）
    localStorage.setItem('clw2.tree-first-open:书A', '1') // 修复前错误形态（冒号）
    mocks.deleteBook.mockResolvedValue(undefined)
    const s = useShelf()
    s.requestDelete(['书A'])
    await s.confirmDelete()
    expect(localStorage.getItem(treeFirstOpenKey('书A'))).toBeNull()
    expect(localStorage.getItem('clw2.tree-first-open:书A')).toBe('1')
  })
})
