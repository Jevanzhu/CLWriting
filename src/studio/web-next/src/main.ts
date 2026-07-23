import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { boot } from './api/client'
import './styles/tokens.css'
import './styles/base.css'
import './composables/useTheme' // 模块加载即 apply 持久化主题（副作用 import，渲染前 CSS 变量就位）

// 启动：先取 token（boot 容错，后端未起则离线态挂载），再挂载应用。
// top-level await：ESM 入口支持，确保任何写请求前 token 就位。
await boot()

createApp(App).use(createPinia()).use(router).mount('#app')
