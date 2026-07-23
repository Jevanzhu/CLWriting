import { createRouter, createWebHistory } from 'vue-router'

// 路由极简两级（M10 R2）：/shelf 书架、/book/:name 工作区；tab 态由 workspace store 自管。
// T0.1 先接占位页；T0.5 落 Shelf.vue / Book.vue。
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/shelf' },
    {
      path: '/shelf',
      component: () => import('./pages/_Placeholder.vue'),
      props: { title: '书架（T0.5 实现）' },
    },
    {
      path: '/book/:name',
      component: () => import('./pages/Book.vue'),
    },
  ],
})

export default router
