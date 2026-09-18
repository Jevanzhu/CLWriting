// @vitest-environment happy-dom
/**
 * 0918二轮修复批（F102）：整页书架渲染帽回归。
 *
 * 修复前 pages/Shelf.vue 不给 ShelfGrid 传 render-cap（「不传 = 不裁」）——数百书
 * 时整页全量挂载 + 入场动画，与浮层书架（ShelfModal 同族性能论证 R-P3-4，帽值
 * SHELF_RENDER_CAP=100）口径不一。修复后整页与浮层同传 shared/render-cap 单源帽。
 *
 * 本文件挂真整页（真 stores/shelf + mock api/shelf 的 listBooks）：500 本书只渲染
 * 前 100 张书卡 + 尾部省略提示行；数据面不动（头部总数/分组计数仍面向全量 500）；
 * 空态判定（!shelf.books.length）不受帽影响。ShelfGrid 组件级裁剪面与两壳接线
 * 文本锚见 shelf-grid-render-cap.test.ts。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  listBooks: vi.fn(),
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mocks.routerPush,
    replace: mocks.routerReplace,
    currentRoute: { value: { path: '/shelf', params: {} } },
  }),
  useRoute: () => ({ path: '/shelf', params: {} }),
}))
vi.mock('../../../src/studio/web-next/src/api/shelf', () => ({ listBooks: mocks.listBooks }))

import Shelf from '../../../src/studio/web-next/src/pages/Shelf.vue'
import { SHELF_RENDER_CAP } from '../../../src/studio/web-next/src/shared/render-cap'
import type { BookEntry } from '../../../src/studio/web-next/src/api/shelf'

// 本环境 happy-dom 未透出 localStorage 全局（use-shelf-delete 同款 Map 替身）
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

function book(i: number): BookEntry {
  return {
    name: `书${String(i).padStart(3, '0')}`,
    title: `书${String(i).padStart(3, '0')}`,
    kind: 'long',
    chapters: 1,
    words: 1000,
    lastEdited: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
  }
}

function seedBooks(n: number): void {
  mocks.listBooks.mockResolvedValue({ books: Array.from({ length: n }, (_, i) => book(i)), workDir: true })
}

async function mountPage() {
  const wrapper = mount(Shelf)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  localStorage.clear() // 书架快照缓存（clw.shelf.cache.v1）跨用例隔离
})

describe('F102：整页书架渲染帽（500 本形态）', () => {
  it(`500 本书 → 只渲染前 ${SHELF_RENDER_CAP} 张卡 + 「已省略 400 部」提示行`, async () => {
    seedBooks(500)
    const wrapper = await mountPage()
    expect(wrapper.findAll('.book-card')).toHaveLength(SHELF_RENDER_CAP)
    const hint = wrapper.find('.cap-hint')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('已省略 400 部')
    wrapper.unmount()
  })

  it('数据面不动：头部总数与分组计数仍面向全量 500（帽只裁渲染不裁数据集）', async () => {
    seedBooks(500)
    const wrapper = await mountPage()
    expect(wrapper.find('.head-sub').text()).toContain('500 部')
    expect(wrapper.find('.section-count').text()).toContain('500 部')
    wrapper.unmount()
  })

  it('空态判定不受帽影响：0 本书 → 空态引导渲染、零书卡零提示行', async () => {
    seedBooks(0)
    const wrapper = await mountPage()
    expect(wrapper.findComponent({ name: 'EmptyState' }).exists()).toBe(true)
    expect(wrapper.findAll('.book-card')).toHaveLength(0)
    expect(wrapper.find('.cap-hint').exists()).toBe(false)
    wrapper.unmount()
  })
})
