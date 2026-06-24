import { createRouter, createWebHistory } from 'vue-router'

/**
 * 前端路由(懒加载拆包,P2 前端首包优化):页面按需加载,主包只含书架。
 * / 书架,/books/new 建书,/books/:name 单书,/books/:name/health 体检,/books/:name/edit 编辑。
 * /books/new 静态路径排在 /books/:name 前(避免 new 被当 :name)。
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/Bookshelf.vue') },
    { path: '/books/new', component: () => import('./pages/BookNew.vue') },
    { path: '/books/:name', component: () => import('./pages/BookDetail.vue') },
    { path: '/books/:name/health', component: () => import('./pages/Health.vue') },
    { path: '/books/:name/edit', component: () => import('./pages/Editor.vue') },
    { path: '/books/:name/rhythm', component: () => import('./pages/Rhythm.vue') },
    { path: '/books/:name/piece/:no', component: () => import('./pages/PieceDetail.vue') },
    { path: '/books/:name/leads', component: () => import('./pages/Leads.vue') },
    { path: '/books/:name/settings', component: () => import('./pages/Settings.vue') },
    { path: '/books/:name/workbench', component: () => import('./pages/Workbench.vue') },
    { path: '/books/:name/config', component: () => import('./pages/Config.vue') },
  ],
})

export default router
