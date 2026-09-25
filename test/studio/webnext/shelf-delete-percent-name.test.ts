// @vitest-environment happy-dom
/**
 * 0918二轮修复批（F101）：ShelfModal 删书回调对书名含 % 的收尾链回归。
 *
 * 修复前 onDeleted 里 `decodeURIComponent(current)` 是二次解码（vue-router 4 的
 * route.params 已解码一次）——服务端书名校验（src/install/books.ts）不拒 %，书名
 * 「50%胜率」可正常建书，删除当前打开的这本书时：
 * - 「%胜」非法百分号序列 → URIError 抛进 useShelf.confirmDelete 的 catch →
 *   deleteError 显示误导性「删除失败」（书实际已删成），且 R65-54 收尾链
 *   （清 LAST_BOOK_KEY + closeShelf + replace('/shelf') 离开死路由）整链跳过；
 * - 含法 %XX 形态（书名原样含 %25）不抛错，但双解后与原名不等 → 静默跳过收尾。
 *
 * 修复后直取 params（已解码形态）与 names 比对。本文件挂真 ShelfModal（useShelf
 * 经 importOriginal 包装捕获组件内实例），走完整 requestDelete → confirmDelete 链
 * 断言：不抛错、deleteError 不误报、LAST_BOOK_KEY 被清、replace('/shelf') 被调。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  deleteBook: vi.fn(),
  clearFalsePositiveMarks: vi.fn(),
  shelfLoad: vi.fn(async () => {}),
  // vue-router mock（global-overlay-mounts 双路径先例；alias 钉嵌套副本，裸名 mock 即命中）
  routerReplace: vi.fn(),
  routerPush: vi.fn(),
  // F101 断言核心槽位：当前路由 params.name（挂载前按用例设置为「vue-router 已解码」形态）
  routeParams: { name: '' as string | undefined },
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mocks.routerPush,
    replace: mocks.routerReplace,
    currentRoute: { value: { path: '/book/x', params: mocks.routeParams } },
  }),
  useRoute: () => ({ path: '/book/x', params: mocks.routeParams }),
}))

// api/stores mock 面与 use-shelf-delete.test.ts 同款（confirmDelete 链的最小依赖）
vi.mock('../../../src/studio/web-next/src/api/shelf', () => ({ deleteBook: mocks.deleteBook }))
vi.mock('../../../src/studio/web-next/src/stores/check', () => ({ clearFalsePositiveMarks: mocks.clearFalsePositiveMarks }))
vi.mock('../../../src/studio/web-next/src/stores/shelf', () => ({
  useShelfStore: vi.fn(() => ({ books: [], load: mocks.shelfLoad })),
}))
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  // setOverlayDimmed：ui store 的 maskAlpha watch 消费（openShelf 变浓度即触达）
  usePrefsStore: vi.fn(() => ({ shelfView: 'grid', setShelfView: vi.fn(), setOverlayDimmed: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return { ...actual, apiJson: vi.fn() }
})

// 真用 useShelf、只捕获组件内创建的实例（options + 返回句柄）——断言走完整
// confirmDelete 链，回调抛错会落 deleteError，比裸调回调更能锚「删除成功却报错」
const captured = vi.hoisted(() => ({ instance: null as ReturnType<typeof import('../../../src/studio/web-next/src/composables/useShelf').useShelf> | null }))
vi.mock('../../../src/studio/web-next/src/composables/useShelf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/composables/useShelf')>()
  return {
    ...actual,
    useShelf: (options?: Parameters<typeof actual.useShelf>[0]) => {
      const inst = actual.useShelf(options)
      captured.instance = inst
      return inst
    },
  }
})

import ShelfModal from '../../../src/studio/web-next/src/components/ui/ShelfModal.vue'
import { LAST_BOOK_KEY } from '../../../src/studio/web-next/src/shared/storage-keys'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

// node 环境无 localStorage，Map 替身（use-shelf-delete 先例）
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

async function mountModal(): Promise<void> {
  mount(ShelfModal)
  await flushPromises()
}

/** 删书全链：requestDelete + confirmDelete（经组件内 useShelf 实例走真 confirmDelete） */
async function deleteBooks(names: string[]): Promise<void> {
  captured.instance!.requestDelete(names)
  await captured.instance!.confirmDelete()
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  localStorage.clear()
  captured.instance = null
  mocks.deleteBook.mockResolvedValue(undefined)
  mocks.shelfLoad.mockClear()
  mocks.routeParams.name = undefined
})

describe('F101：删当前书（书名含 %）→ 收尾链完整', () => {
  it('「50%胜率」：不抛 URIError，deleteError 不误报，LAST_BOOK_KEY 被清 + replace(/shelf)', async () => {
    // 路由形态按 vue-router 4 契约：URL /book/50%25%E8%83%9C%E7%8E%87 经 params 解码一次
    mocks.routeParams.name = '50%胜率'
    localStorage.setItem(LAST_BOOK_KEY, '50%胜率')
    await mountModal()

    // 修复前：decodeURIComponent('50%胜率') 抛 URIError → catch → deleteError 误报
    await expect(deleteBooks(['50%胜率'])).resolves.toBeUndefined()
    expect(captured.instance!.deleteError.value).toBeFalsy()
    expect(localStorage.getItem(LAST_BOOK_KEY)).toBeNull()
    expect(mocks.routerReplace).toHaveBeenCalledWith('/shelf')
  })

  it('「百%25分」（书名原样含 %25，含法百分号序列）：names 匹配走收尾，不静默跳过', async () => {
    // 修复前：decodeURIComponent('百%25分') = '百分' ≠ names 里的原名 → 跳过收尾
    //（不抛错但 replace 不调、键不清，死路由滞留）
    mocks.routeParams.name = '百%25分'
    localStorage.setItem(LAST_BOOK_KEY, '百%25分')
    await mountModal()

    await deleteBooks(['百%25分'])
    expect(captured.instance!.deleteError.value).toBeFalsy()
    expect(localStorage.getItem(LAST_BOOK_KEY)).toBeNull()
    expect(mocks.routerReplace).toHaveBeenCalledWith('/shelf')
  })

  it('删的不是当前书 → 不收尾：replace 不调，他书 LAST_BOOK_KEY 保留', async () => {
    mocks.routeParams.name = '50%胜率'
    localStorage.setItem(LAST_BOOK_KEY, '50%胜率')
    await mountModal()

    await deleteBooks(['别的书'])
    expect(mocks.routerReplace).not.toHaveBeenCalled()
    expect(localStorage.getItem(LAST_BOOK_KEY)).toBe('50%胜率')
  })

  it('删当前书时浮层开着 → closeShelf 收浮层（收尾链三件齐走）', async () => {
    mocks.routeParams.name = '50%胜率'
    await mountModal()
    const ui = useUiStore()
    ui.openShelf()

    await deleteBooks(['50%胜率'])
    expect(ui.shelfOpen).toBe(false)
    expect(mocks.routerReplace).toHaveBeenCalledWith('/shelf')
  })
})
