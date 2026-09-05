// @vitest-environment happy-dom
/**
 * R50-D1-2（五十轮）回归：启动 lastBook 恢复直进以路由态为判据。
 * 修复前裸 location.pathname === '/' 在 onMounted 时刻与路由初始导航
 *（'/' redirect '/shelf'）存在竞态（初始导航完成前后读值不一）；
 * 修复后 router.isReady().then() 内读 currentRoute.value.path——仅根路径时
 * replace 到 /book/<encoded>（保留原语义）。mount 级：App.vue 全挂载，
 * vue-router 双路径 mock（r42-global-overlays 同款，扩展 isReady/currentRoute）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// App.vue 启动链拉 api/client（getLastInitialBook）——局部 mock（保留类型面）
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return { ...actual, getLastInitialBook: () => null }
})

// 双路径 vue-router mock（App/useAppActions/ShelfModal 消费 useRouter）。
// 工厂内不得引用顶层变量（vi.mock 提升语义）——holder 经 hoisted 持有者共享。
const holder = vi.hoisted(() => ({
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    isReady: vi.fn(async () => {}),
    currentRoute: { value: { path: '/' } },
  },
  route: null as unknown as { params: Record<string, string>; path: string },
}))
vi.mock('vue-router', async () => {
  const { reactive, defineComponent } = await import('vue')
  holder.route = reactive({ params: {}, path: '/' })
  return {
    useRoute: () => holder.route,
    useRouter: () => holder.router,
    RouterView: defineComponent({ name: 'RouterView', render: () => null }),
  }
})
vi.mock('../../../src/studio/web-next/node_modules/vue-router', async () => {
  const { defineComponent } = await import('vue')
  return {
    useRoute: () => holder.route,
    useRouter: () => holder.router,
    RouterView: defineComponent({ name: 'RouterView', render: () => null }),
  }
})

import App from '../../../src/studio/web-next/src/App.vue'

const LAST_BOOK_KEY = 'clw-last-book'

// happy-dom localStorage 在 vitest 集成下不可靠——Map 替身顶上（onboard-premise-flush
// 同款形态），App.vue 的 localStorage.getItem('clw-last-book') 走该桩
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
  clear: () => storage.clear(),
})

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  vi.clearAllMocks()
  holder.router.currentRoute.value.path = '/'
  storage.clear()
})

async function mountApp() {
  const wrapper = mount(App, { global: { plugins: [createPinia()] } })
  await flushPromises()
  return wrapper
}

describe('R50-D1-2: lastBook 恢复直进以路由态（isReady 后 currentRoute.path）为判据', () => {
  it('isReady 后 path 为 / → replace 到 /book/<encoded lastBook>', async () => {
    localStorage.setItem(LAST_BOOK_KEY, '书A')
    const w = await mountApp()
    expect(holder.router.replace).toHaveBeenCalledTimes(1)
    expect(holder.router.replace).toHaveBeenCalledWith('/book/%E4%B9%A6A')
    w.unmount()
  })

  it('isReady 后 path 非 /（初始导航已 redirect 到 /shelf）→ 不 replace（仅根路径恢复直进语义保留）', async () => {
    localStorage.setItem(LAST_BOOK_KEY, '书A')
    holder.router.currentRoute.value.path = '/shelf'
    const w = await mountApp()
    expect(holder.router.replace).not.toHaveBeenCalled()
    w.unmount()
  })

  it('无 lastBook → 不 replace', async () => {
    const w = await mountApp()
    expect(holder.router.replace).not.toHaveBeenCalled()
    w.unmount()
  })
})
