import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { boot } from './api/client'
import { usePrefsStore } from './stores/prefs'
import { useUiStore } from './stores/ui'
import './styles/tokens.css'
import './styles/base.css'
// 设置域共享类（.val/.save-btn/.seg 药丸等）被设置域外组件消费（右栏面板、导出弹窗），
// 全局装载使依赖显式化（原先靠 SettingsModal 被静态 import 间接生效）。
import './components/ui/settings-shared.css'

// 启动：boot 取 token → 加载全局偏好（.clwriting/global.json）→ 挂载应用。
// top-level await：ESM 入口支持，确保渲染前 token + 偏好就位。
await boot()

// 全局偏好异步加载（主题 + 排版 + 字体；首次从旧 localStorage 迁移到 JSON 文件）。
// createPinia 不自动 setActivePinia，组件外用 store 前需手动设 active。
const pinia = createPinia()
setActivePinia(pinia)
await usePrefsStore().init() // init 内部 applyTheme + apply（渲染前 CSS 变量就位）
useUiStore().probeAiStatus() // G4：后台探测 AI 可达性（不阻塞挂载，置灰工作台/开书）

const app = createApp(App)
// 全局错误兜底：ErrorBoundary 漏网或 setup 外的异常最终经 ui store 的上报通道
// （console.error 留痕 + toast 冒泡，原先只 console.error 对作者完全静默）
app.config.errorHandler = (err, _instance, info) => {
  useUiStore().reportUnhandledError(err, info)
}
app.use(pinia).use(router).mount('#app')
