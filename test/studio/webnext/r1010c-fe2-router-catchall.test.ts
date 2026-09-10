// @vitest-environment happy-dom
/**
 * R1010c-FE2-P3-3（2026-09-10 全量独立复审修复批）回归：router 404 catch-all。
 * 手输坏 URL 原先无匹配路由、router-view 渲染空白；补 /:pathMatch(.*)* 重定向书架。
 * 用 router.ts 导出的真实路由表建 memory router（不手抄表——表漂移即红；导航流水线
 * 会真实解析 lazy 组件，/shelf 落地即书架页可导航性的行为级验证）。
 * lastBook 直进语义不受影响的行为面：App.vue 只在 redirectedFrom?.path === '/'（根
 * 路径进入）时 hijack——catch-all 重定向后 redirectedFrom 是原坏路径，不误触发直进。
 */
import { describe, it, expect } from 'vitest'
// 裸名 'vue-router' 从 test/ 目录解析不到包（web-next 嵌套布局，R61-20 先例）——
// 钉嵌套路径，与 vitest alias 目标同包入口（同一模块实例）。
import { createRouter, createMemoryHistory } from '../../../src/studio/web-next/node_modules/vue-router'
import { routes } from '../../../src/studio/web-next/src/router'

function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes })
}

describe('R1010c-FE2-P3-3: 404 catch-all 重定向书架', () => {
  it('手输坏 URL（多段）→ 重定向 /shelf，redirectedFrom 保留原坏路径', async () => {
    const router = makeRouter()
    await router.push('/bad/url')
    expect(router.currentRoute.value.path).toBe('/shelf')
    expect(router.currentRoute.value.redirectedFrom?.path).toBe('/bad/url')
  })

  it('坏 URL 的 redirectedFrom ≠ / → App 的 lastBook 直进判据不触发（catch-all 不影响直进语义）', async () => {
    const router = makeRouter()
    await router.push('/not-a-book')
    expect(router.currentRoute.value.path).toBe('/shelf')
    expect(router.currentRoute.value.redirectedFrom?.path).toBe('/not-a-book')
    expect(router.currentRoute.value.redirectedFrom?.path === '/').toBe(false)
  })

  it('根路径进入 → redirectedFrom === /（lastBook 直进判据依赖的既有形态不回退）', async () => {
    const router = makeRouter()
    await router.push('/')
    expect(router.currentRoute.value.path).toBe('/shelf')
    expect(router.currentRoute.value.redirectedFrom?.path).toBe('/')
  })

  it('既有路由不回退：/shelf、/book/:name、/library、/welcome 均命中且不被 catch-all 吞掉', () => {
    const router = makeRouter()
    expect(router.resolve('/shelf').matched).toHaveLength(1)
    expect(router.resolve('/book/书A').matched).toHaveLength(1)
    expect(router.resolve('/library').matched).toHaveLength(1)
    expect(router.resolve('/welcome').matched).toHaveLength(1)
  })
})
