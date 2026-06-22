import { createRouter, createWebHistory } from 'vue-router'
import Bookshelf from './pages/Bookshelf.vue'
import BookNew from './pages/BookNew.vue'
import BookDetail from './pages/BookDetail.vue'
import Health from './pages/Health.vue'

/**
 * 前端路由：/ 书架，/books/new 建书，/books/:name 单书，/books/:name/health 体检。
 * /books/new 静态路径排在 /books/:name 前（避免 new 被当 :name）。
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Bookshelf },
    { path: '/books/new', component: BookNew },
    { path: '/books/:name', component: BookDetail },
    { path: '/books/:name/health', component: Health },
  ],
})

export default router
