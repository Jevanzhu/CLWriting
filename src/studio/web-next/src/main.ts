import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './styles/tokens.css'
import './styles/base.css'
import './composables/useTheme' // 模块加载即 apply 持久化主题（副作用 import，渲染前 CSS 变量就位）

// web-next 入口（M10 Obsidian 重写）。createApp + pinia + router。
createApp(App).use(createPinia()).use(router).mount('#app')
