// @vitest-environment happy-dom
/**
 * R50-D1-2（五十轮）沿革 + 重评2-P1-1（2026-09-09 全量重评 GLM-5.3）修复重写：
 * 启动 lastBook 恢复直进「由根路径进入」判据回归。
 * R50-D1-2 曾把裸 location.pathname 判据改为路由态（isReady 后 currentRoute.path），
 * 但本文件旧版整体 mock vue-router（isReady 空转、currentRoute 手持 '/'）——从未经过
 * 真实 redirect 链，恰把死行为钉成假绿：真实 router.ts 配 '/' redirect '/shelf'，
 * isReady() 在初始导航（含 redirect）完成后 resolve，此刻 path 恒为 '/shelf'，原判据
 * `path === '/'` 恒假——lastBook 恢复与 --book 首启直进（getLastInitialBook 汇入同
 * 分支）确定性失效（重评2-P1-1）。修复判据改为 redirectedFrom?.path === '/'（保留
 * path === '/' 直判兜底）；本文件同步重写为真实 vue-router 实例：createMemoryHistory +
 * 路径结构照抄 router.ts（'/' redirect '/shelf' 等）但组件用轻量 stub（不拉真
 * Shelf.vue 全链），App.vue 以 router 插件真挂载走完整初始导航。api/client 仍局部
 * mock（getLastInitialBook 经 hoisted 持有者按用例可控）；happy-dom localStorage
 * 在 vitest 集成下不可靠——Map 替身沿用原文件形态。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
// 裸名 'vue-router' 从 test/ 目录向上解析不到包（web-next 嵌套布局，R61-20 vitest
// alias 只管运行时）——vue-tsc 对本文件 TS2307；按 R61-20 注释自记先例直接钉嵌套
// 路径，与 alias 目标同包入口（同一模块实例，App.vue 侧注入键一致）。
import { createRouter, createMemoryHistory } from '../../../src/studio/web-next/node_modules/vue-router'
import { defineComponent } from 'vue'

// App.vue 启动链拉 api/client（getLastInitialBook）——局部 mock（保留类型面）；
// initialBook 按 hoisted 持有者可控（用例④验 initialBook > lastBook 优先级）。
// 工厂内不得引用顶层变量（vi.mock 提升语义）。
const holder = vi.hoisted(() => ({ initialBook: null as string | null }))
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return { ...actual, getLastInitialBook: () => holder.initialBook }
})

// vue-router 不再 mock：'vue-router' 经 vitest alias 钉到 web-next 嵌套副本（R61-20），
// 与 App.vue 内 import 同一模块实例，install/useRouter 注入键天然一致。

import App from '../../../src/studio/web-next/src/App.vue'

const LAST_BOOK_KEY = 'clw-last-book'

// 轻量页面 stub：路径结构照抄 router.ts（'/' redirect '/shelf'、/shelf、/book/:name、
// /library、/welcome），组件空渲染——只验 App 启动直进判据，不加载真页面全链。
const pageStub = (name: string) => defineComponent({ name, render: () => null })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/shelf' },
      { path: '/shelf', component: pageStub('ShelfStub') },
      { path: '/book/:name', component: pageStub('BookStub') },
      { path: '/library', component: pageStub('LibraryStub') },
      { path: '/welcome', component: pageStub('WelcomeStub') },
    ],
  })
}

// happy-dom localStorage 在 vitest 集成下不可靠——Map 替身顶上（onboard-premise-flush
// 同款形态），App.vue 的 localStorage.getItem('clw-last-book') 走该桩
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
  clear: () => storage.clear(),
})

async function mountApp(router: ReturnType<typeof makeRouter>) {
  const wrapper = mount(App, { global: { plugins: [createPinia(), router] } })
  // 初始导航（含 redirect）真实完成 + App 的 isReady().then 回调链（含 replace）落地
  await router.isReady()
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  holder.initialBook = null
  storage.clear()
})

describe('重评2-P1-1 / R50-D1-2: lastBook 恢复直进——真实 redirect 链下「由根路径进入」判据', () => {
  it('初始 URL / 经真实 redirect 落 /shelf + lastBook 存在 → replace 到 /book/<encoded lastBook>', async () => {
    localStorage.setItem(LAST_BOOK_KEY, '书A')
    const router = makeRouter()
    const replaceSpy = vi.spyOn(router, 'replace')
    const w = await mountApp(router)
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(replaceSpy).toHaveBeenCalledWith('/book/%E4%B9%A6A')
    expect(router.currentRoute.value.path).toBe('/book/%E4%B9%A6A')
    w.unmount()
  })

  it('初始 URL /library（非根路径进入，深链直开）+ lastBook 存在 → 不 hijack', async () => {
    localStorage.setItem(LAST_BOOK_KEY, '书A')
    const router = makeRouter()
    // 深链初始入口：install 前预推 '/library'（vue-router 官方 SSR 同款时序）——
    // install 时 currentRoute 已非 START，不再按 '/' 走初始导航，redirectedFrom 为空
    await router.push('/library')
    const replaceSpy = vi.spyOn(router, 'replace')
    const w = await mountApp(router)
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/library')
    w.unmount()
  })

  it('无 lastBook（也无 initialBook）→ 不 replace 落 /shelf，且真实 redirect 链锚定（原 path === / 判据恒假的实证）', async () => {
    const router = makeRouter()
    const replaceSpy = vi.spyOn(router, 'replace')
    const w = await mountApp(router)
    expect(replaceSpy).not.toHaveBeenCalled()
    // isReady 后初始导航经 '/' → redirect '/shelf'：path 是目标而非来源——旧判据
    // `path === '/'` 在该真实链上恒假（重评2-P1-1 死代码根因），判据须读 redirectedFrom
    expect(router.currentRoute.value.redirectedFrom?.path).toBe('/')
    expect(router.currentRoute.value.path).toBe('/shelf')
    w.unmount()
  })

  it('getLastInitialBook()（--book 首启直进）有值 → 优先于 lastBook，直进该书', async () => {
    localStorage.setItem(LAST_BOOK_KEY, '书A')
    holder.initialBook = '书B'
    const router = makeRouter()
    const replaceSpy = vi.spyOn(router, 'replace')
    const w = await mountApp(router)
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(replaceSpy).toHaveBeenCalledWith('/book/%E4%B9%A6B')
    expect(router.currentRoute.value.path).toBe('/book/%E4%B9%A6B')
    w.unmount()
  })
})
