import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { boot } from './api/client'
import { usePrefsStore } from './stores/prefs'
import './styles/tokens.css'
import './styles/base.css'
import './composables/useTheme' // 模块加载即 apply 持久化主题（副作用 import，渲染前 CSS 变量就位）

// 启动：先取 token（boot 容错，后端未起则离线态挂载），再挂载应用。
// top-level await：ESM 入口支持，确保任何写请求前 token 就位。
await boot()

// 正文排版偏好预 apply（渲染前 :root 的 --prose-* 就位，避免闪默认值）。
// createPinia 不自动 setActivePinia，组件外用 store 前需手动设 active。
const pinia = createPinia()
setActivePinia(pinia)
usePrefsStore().apply()

createApp(App).use(pinia).use(router).mount('#app')
