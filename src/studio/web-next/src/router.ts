import { createRouter, createWebHistory } from 'vue-router'

// 路由极简两级（M10 R2）：/shelf 书架、/book/:name 工作区；tab 态由 workspace store 自管。
// /library 书库管理、/welcome 首启引导为后补直挂路由（不在两级模型内，独立整页）。
const router = createRouter({
  history: createWebHistory(),
  routes: [
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
  ],
})

export default router
