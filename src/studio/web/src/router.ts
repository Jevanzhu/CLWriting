import { createRouter, createWebHistory } from 'vue-router'
import Bookshelf from './pages/Bookshelf.vue'
import BookNew from './pages/BookNew.vue'
import BookDetail from './pages/BookDetail.vue'
import Health from './pages/Health.vue'
import Editor from './pages/Editor.vue'
import Rhythm from './pages/Rhythm.vue'
import Leads from './pages/Leads.vue'
import Settings from './pages/Settings.vue'
import Workbench from './pages/Workbench.vue'
import Config from './pages/Config.vue'

/**
 * 前端路由：/ 书架，/books/new 建书，/books/:name 单书，/books/:name/health 体检，/books/:name/edit 编辑。
 * /books/new 静态路径排在 /books/:name 前（避免 new 被当 :name）。
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Bookshelf },
    { path: '/books/new', component: BookNew },
    { path: '/books/:name', component: BookDetail },
    { path: '/books/:name/health', component: Health },
    { path: '/books/:name/edit', component: Editor },
    { path: '/books/:name/rhythm', component: Rhythm },
    { path: '/books/:name/leads', component: Leads },
    { path: '/books/:name/settings', component: Settings },
    { path: '/books/:name/workbench', component: Workbench },
    { path: '/books/:name/config', component: Config },
  ],
})

export default router
