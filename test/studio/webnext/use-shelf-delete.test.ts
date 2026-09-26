/**
 * useShelf.confirmDelete 删书链行为族——按行为合并两散落文件
 * （原 use-shelf-delete + r71-shelf-delete-404，装置同构：真 ApiError + localStorage
 * Map 替身，node 环境）。
 *
 * - R65-54（十三轮批 E-6）：confirmDelete 成功后 onDeleted 回调。ShelfModal 借它在
 *   「删掉当前打开的书」时导航离开死路由 /book/:name——回调契约：成功（全部删完）必调
 *   且带全量名单；失败不调（保留弹窗重试语义）。
 * - R71-26（七十一轮）：批量删书串行循环，部分失败后重试时已删书 404 直接抛 → 后续书
 *   永远删不掉。修复：循环内单书删除 catch 判 404/NOT_FOUND（ApiError 形状：status/code）
 *   视为已删继续；其余错误照旧中断记失败（弹窗保留可重试语义不变）。
 * - R27-79（二十七轮）：删书连带清该书 localStorage 残留键。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  deleteBook: vi.fn(),
  clearFalsePositiveMarks: vi.fn(),
  shelfLoad: vi.fn(async () => {}),
}))
vi.mock('../../../src/studio/web-next/src/api/shelf', () => ({ deleteBook: mocks.deleteBook }))
vi.mock('../../../src/studio/web-next/src/stores/check', () => ({
  clearFalsePositiveMarks: mocks.clearFalsePositiveMarks,
}))
vi.mock('../../../src/studio/web-next/src/stores/shelf', () => ({
  useShelfStore: vi.fn(() => ({ books: [], load: mocks.shelfLoad })),
}))
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: vi.fn(() => ({ shelfView: 'grid', setShelfView: vi.fn() })),
}))
// 重评-0914-三轮 nano R7-1：ApiError 本地复刻收编——工厂改 importOriginal 展开，真类单源 src/studio/web-next/src/api/client.ts
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    apiJson: vi.fn(),
  }
})

import { ApiError } from '../../../src/studio/web-next/src/api/client'
import { useShelf } from '../../../src/studio/web-next/src/composables/useShelf'
import { treeFirstOpenKey } from '../../../src/studio/web-next/src/shared/storage-keys'

// R27-79：localStorage 键清扫断言用（node 环境默认无 localStorage，Map 替身照
// panel-toast-switch-guard 范型；loadSortPreference 的 try/catch 对缺 API 本就兼容）
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

// ── R71-26（七十一轮）：部分失败后重试——已删书 404 视为已删继续 ──

const notFound = () => new ApiError('没有这本书：书A', 404, 'NOT_FOUND')

describe('R71-26: confirmDelete 部分失败后重试——已删书 404 视为已删继续', () => {
  it('三书删中间失败 → 重试：已删书A 404 不抛，继续删书B/书C 直至全部完成', async () => {
    // 首轮：A 成功、B 失败（500）→ 循环中断，C 未尝试
    mocks.deleteBook
      .mockResolvedValueOnce(undefined) // 书A
      .mockRejectedValueOnce(new ApiError('服务异常', 500, 'INTERNAL')) // 书B 中断
    const s = useShelf()
    s.requestDelete(['书A', '书B', '书C'])
    await s.confirmDelete()
    expect(s.deleteError.value).toBeTruthy()
    expect(s.confirmTarget.value).toEqual(['书A', '书B', '书C']) // 弹窗保留（重试带全量名单）
    expect(mocks.deleteBook).toHaveBeenCalledTimes(2)

    // 重试：A 已删（404）→ 视为已删继续；B/C 正常删完
    mocks.deleteBook.mockReset()
    mocks.deleteBook
      .mockRejectedValueOnce(notFound()) // 书A 重删 404
      .mockResolvedValueOnce(undefined) // 书B
      .mockResolvedValueOnce(undefined) // 书C
    await s.confirmDelete()
    expect(mocks.deleteBook).toHaveBeenCalledTimes(3) // 修复点：404 后循环不中断，书C 也删到（修复前停在书A）
    expect(s.confirmTarget.value).toBeNull() // 全部删完 → 弹窗关闭
    expect(s.batchMode.value).toBe(false)
    expect(mocks.shelfLoad).toHaveBeenCalled()
    // 注：deleteError 残留首轮文案是既有行为（成功路径不清、requestDelete 入口清），
    // 弹窗已关无展示面，不纳入本修复断言
  })

  it('非 404 错误照旧中断：重试遇 500 仍记失败、弹窗保留（守卫不放宽）', async () => {
    mocks.deleteBook.mockRejectedValueOnce(notFound()).mockRejectedValueOnce(new ApiError('服务异常', 500, 'INTERNAL'))
    const s = useShelf()
    s.requestDelete(['书A', '书B'])
    await s.confirmDelete()
    expect(s.deleteError.value).toBeTruthy()
    expect(s.confirmTarget.value).toEqual(['书A', '书B']) // 弹窗保留可再重试
  })

  it('404 分支同样清误报灰显键（书已不存在，键不该留——幂等无实害）', async () => {
    mocks.deleteBook.mockRejectedValueOnce(notFound())
    const s = useShelf()
    s.requestDelete(['书A'])
    await s.confirmDelete()
    expect(mocks.clearFalsePositiveMarks).toHaveBeenCalledWith('书A')
  })
})
