import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

// 路由极简两级（M10）：/shelf 书架、/book/:name 工作区；tab 态由 workspace store 自管。
// /library 书库管理、/welcome 首启引导为后补直挂路由（不在两级模型内，独立整页）。
//
// 路由表导出面**测试专用**（零生产消费方）：主应用只取 default（createRouter 装配处同档），
// 具名导出的用途是让 404 catch-all 的行为级测试拿真实表建 memory router——手抄一份表会与
// 本档漂移，测试对 catch-all 的守门就失效（表漂移即测试红）。
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
  // 404 catch-all 兜底——手输坏 URL 原先无匹配、router-view 渲染空白，
  // 现重定向回书架。lastBook 直进语义不受影响：App.vue 的直进判据是 redirectedFrom?.path
  // === '/'（根路径进入才 hijack），坏 URL 的 redirectedFrom 是原坏路径，不会误触发直进。
  { path: '/:pathMatch(.*)*', redirect: '/shelf' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
