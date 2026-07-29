import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { boot } from './api/client'
import { usePrefsStore } from './stores/prefs'
import { useUiStore } from './stores/ui'
import './styles/tokens.css'
import './styles/base.css'

// 启动：boot 取 token → 加载全局偏好（.clwriting/global.json）→ 挂载应用。
// top-level await：ESM 入口支持，确保渲染前 token + 偏好就位。
await boot()

// 全局偏好异步加载（主题 + 排版 + 字体；首次从旧 localStorage 迁移到 JSON 文件）。
// createPinia 不自动 setActivePinia，组件外用 store 前需手动设 active。
const pinia = createPinia()
setActivePinia(pinia)
await usePrefsStore().init() // init 内部 applyTheme + apply（渲染前 CSS 变量就位）
useUiStore().probeAiStatus() // G4：后台探测 AI 可达性（不阻塞挂载，置灰工作台/开书）

createApp(App).use(pinia).use(router).mount('#app')
