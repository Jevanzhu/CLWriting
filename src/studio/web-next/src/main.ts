import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'

// web-next 入口（M10 Obsidian 重写）。createApp + pinia + router。
// 主题 apply（T0.2 useTheme）与 tokens 将在此 import 触发。
createApp(App).use(createPinia()).use(router).mount('#app')
