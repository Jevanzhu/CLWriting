import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

// 路由极简两级（M10 R2）：/shelf 书架、/book/:name 工作区；tab 态由 workspace store 自管。
// /library 书库管理、/welcome 首启引导为后补直挂路由（不在两级模型内，独立整页）。
// R1010c-FE2-P3-3（2026-09-10 全量独立复审修复批）：路由表提升为具名导出——404 catch-all
// 的行为级测试用真实表建 memory router（不手抄路由表，表漂移即测试红），主应用装配不变。
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/shelf' },
  {
    path: '/shelf',
    component: () => import('./pages/Shelf.vue'),
  },
  {
    path: '/book/:name',
    component: () => import('./pages/Book.vue'),
  },
  {
    path: '/library',
    component: () => import('./pages/Library.vue'),
  },
  {
    path: '/welcome',
    component: () => import('./pages/Welcome.vue'),
  },
  // R1010c-FE2-P3-3：404 catch-all 兜底——手输坏 URL 原先无匹配、router-view 渲染空白，
  // 现重定向回书架。lastBook 直进语义不受影响：App.vue 的直进判据是 redirectedFrom?.path
  // === '/'（根路径进入才 hijack），坏 URL 的 redirectedFrom 是原坏路径，不会误触发直进。
  { path: '/:pathMatch(.*)*', redirect: '/shelf' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
