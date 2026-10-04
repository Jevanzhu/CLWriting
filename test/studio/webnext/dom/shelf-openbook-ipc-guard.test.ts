/**
 * Shelf 页桌面入口行为（happy-dom）。
 * （原 r42-shell-mount 的 R42-31 节，按行为单拆。）
 *
 * R42-31（四十二轮）：书架独立窗口 openBook IPC reject 被 catch——console.warn 留痕，
 * 不产生 unhandledrejection 抛穿。
 *
 * 返回书库入口：书架页开书库管理窗口 IPC 三态——桌面成功不 toast / 浏览器版 toast 交代
 * 「仅桌面版可用」（书架页无 Ribbon，此为唯一入口，点击必须有响应）/ IPC 失败
 * friendlyError toast。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// api/shelf：Shelf 页 onMounted → shelf.load()，mock listBooks 供书卡渲染
const shelfMocks = vi.hoisted(() => ({
  listBooks: vi.fn(),
  deleteBook: vi.fn(),
  routerPush: vi.fn(),
}))
vi.mock('../../../../src/studio/web-next/src/api/shelf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/studio/web-next/src/api/shelf')>()
  return { ...actual, listBooks: shelfMocks.listBooks, deleteBook: shelfMocks.deleteBook }
})
// vue-router 双注册（R61-20）：web-next 组件解析自己的 node_modules/vue-router，
// 别名钉同份；此处 mock 供 Shelf.vue 的 useRouter
vi.mock('vue-router', () => ({ useRouter: () => ({ push: shelfMocks.routerPush }) }))
vi.mock('../../../../src/studio/web-next/node_modules/vue-router', () => ({
  useRouter: () => ({ push: shelfMocks.routerPush }),
}))

import Shelf from '../../../../src/studio/web-next/src/pages/Shelf.vue'
import ShelfGrid from '../../../../src/studio/web-next/src/components/ui/ShelfGrid.vue'
import { useUiStore } from '../../../../src/studio/web-next/src/stores/ui'
import type { BookEntry } from '../../../../src/studio/web-next/src/api/shelf'

const BOOK: BookEntry = {
  name: '我的书',
  title: '我的书',
  kind: 'long',
  chapters: 3,
  words: 12000,
  lastEdited: '2026-09-01T00:00:00Z',
  createdAt: '2026-08-01T00:00:00Z',
}

describe('R42-31 Shelf 页：openBook IPC reject 不抛穿', () => {
  /** win=shelf 查询参数（书架独立窗口形态）：replaceState 优先；happy-dom 不生效时
   *  defineProperty 兜底（openBook 的 IPC 分支判据） */
  function forceShelfWinParam(): void {
    try {
      window.history.replaceState(null, '', '/shelf?win=shelf')
    } catch {
      /* 走下行兜底 */
    }
    if (window.location.search !== '?win=shelf') {
      Object.defineProperty(window.location, 'search', { value: '?win=shelf', configurable: true })
    }
  }

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).clwritingDesktop
    try {
      window.localStorage.clear()
    } catch {
      /* happy-dom 差异下不可用则跳过 */
    }
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('openBook reject → console.warn 留痕，无 unhandledrejection 抛穿', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    shelfMocks.listBooks.mockReset().mockResolvedValue({ books: [BOOK], workDir: true })
    shelfMocks.routerPush.mockReset()
    forceShelfWinParam()

    const openBook = vi.fn().mockRejectedValue(new Error('ipc down'))
    ;(window as unknown as Record<string, unknown>).clwritingDesktop = { openBook }
    const unhandled: unknown[] = []
    window.addEventListener('unhandledrejection', (e) => unhandled.push(e))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const wrapper = mount(Shelf, { global: { plugins: [pinia] } })
    await flushPromises() // onMounted shelf.load() → 书卡渲染
    const grid = wrapper.findComponent(ShelfGrid)
    expect(grid.exists()).toBe(true)

    grid.vm.$emit('open', BOOK.name) // ShelfGrid @open → Shelf.openBook → IPC 分支
    await flushPromises()
    await new Promise((r) => setTimeout(r, 0)) // 等一拍 macrotask（rejection 微任务链结算）

    expect(openBook).toHaveBeenCalledWith(BOOK.name)
    expect(shelfMocks.routerPush).not.toHaveBeenCalled() // 独立窗口走 IPC，不落路由分支
    expect(warnSpy).toHaveBeenCalledWith('openBook IPC 失败', expect.any(Error)) // catch 留痕
    expect(unhandled).toEqual([]) // 无 unhandledrejection 抛穿
    wrapper.unmount()
  })
})

describe('Shelf 页：返回书库入口（开书库管理窗口）', () => {
  function mountShelf() {
    const pinia = createPinia()
    setActivePinia(pinia)
    shelfMocks.listBooks.mockReset().mockResolvedValue({ books: [BOOK], workDir: true })
    shelfMocks.routerPush.mockReset()
    const wrapper = mount(Shelf, { global: { plugins: [pinia] } })
    return { wrapper, pinia }
  }
  function backButton(wrapper: ReturnType<typeof mount>) {
    const btn = wrapper.findAll('button').find((b) => b.text().includes('返回书库'))
    if (!btn) throw new Error('返回书库按钮未渲染')
    return btn
  }

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).clwritingDesktop
    try {
      window.localStorage.clear()
    } catch {
      /* happy-dom 差异下不可用则跳过 */
    }
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('桌面版点击 → openLibraryWindow IPC 一次，不 toast', async () => {
    const openLibraryWindow = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as Record<string, unknown>).clwritingDesktop = { openLibraryWindow }
    const { wrapper, pinia } = mountShelf()
    await flushPromises()
    const toastSpy = vi.spyOn(useUiStore(pinia), 'toast')
    await backButton(wrapper).trigger('click')
    expect(openLibraryWindow).toHaveBeenCalledTimes(1)
    expect(toastSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('浏览器版（无 clwritingDesktop）点击 → toast「仅桌面版可用」，不静默', async () => {
    const { wrapper, pinia } = mountShelf()
    await flushPromises()
    const toastSpy = vi.spyOn(useUiStore(pinia), 'toast')
    await backButton(wrapper).trigger('click')
    expect(toastSpy).toHaveBeenCalledWith('书库管理仅桌面版可用', 'info')
    wrapper.unmount()
  })

  it('桌面版 IPC 失败 → friendlyError toast', async () => {
    ;(window as unknown as Record<string, unknown>).clwritingDesktop = {
      openLibraryWindow: vi.fn().mockRejectedValue(new Error('窗口创建失败')),
    }
    const { wrapper, pinia } = mountShelf()
    await flushPromises()
    const toastSpy = vi.spyOn(useUiStore(pinia), 'toast')
    await backButton(wrapper).trigger('click')
    await flushPromises()
    expect(toastSpy).toHaveBeenCalledWith('窗口创建失败', 'error')
    wrapper.unmount()
  })
})
