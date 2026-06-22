import { createRouter, createWebHistory } from 'vue-router'
import Bookshelf from './pages/Bookshelf.vue'
import BookDetail from './pages/BookDetail.vue'
import Health from './pages/Health.vue'

/** 前端路由：/ 书架，/books/:name 单书，/books/:name/health 体检（SPA fallback 已就绪，刷新不丢页） */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Bookshelf },
    { path: '/books/:name', component: BookDetail },
    { path: '/books/:name/health', component: Health },
  ],
})

export default router
