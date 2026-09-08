import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { boot } from './api/client'
import { usePrefsStore } from './stores/prefs'
import { useUiStore } from './stores/ui'
import { prewarmSystemFonts } from './composables/useSystemFonts'
import './styles/tokens.css'
import './styles/base.css'
// 设置域共享类（.val/.save-btn/.seg 药丸等）被设置域外组件消费（右栏面板、导出弹窗），
// 全局装载使依赖显式化（原先靠 SettingsModal 被静态 import 间接生效）。
import './components/ui/settings-shared.css'

// 启动：boot 取 token → 加载全局偏好（.clwriting/global.json）→ 挂载应用。
// html 根挂平台标记（win32/mac/…），供全局 CSS 按平台分支（如 win 字体栈适配）。
// 浏览器版无 clwritingDesktop → 不设，CSS 走平台无关默认。
if (window.clwritingDesktop?.platform) {
  document.documentElement.dataset.platform = window.clwritingDesktop.platform
}
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

// 字体表启动预热（2026-09-08 作者反馈「字体下拉首开很慢，特别是第一次」）：win 枚举
// 走 PowerShell + Add-Type PresentationCore（秒级），原先等首个消费组件挂载（设置
// 弹窗/专注排版条）才发 IPC，首次打开字体下拉要现场等枚举完。启动后台提前拉入
// useSystemFonts 单例，首开即全量。idle 调度（首帧渲染后空闲即跑，2s 兜底必跑）：
// 比固定延迟更早覆盖「启动后很快开设置」，且不与启动关键路径抢时机（渲染侧只发
// IPC，枚举在主进程子进程里跑）；期间用户先开设置则消费侧 loadOnce 先行，预热
// 沦为共享同一在途 Promise 的 no-op——R48-84 去重；失败走既有空表降级，不影响
// 启动。浏览器版无 desktop bridge，loadOnce 内自判空。
const FONT_PREWARM_IDLE_TIMEOUT_MS = 2_000
const prewarmFontList = (): void => void prewarmSystemFonts()
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(prewarmFontList, { timeout: FONT_PREWARM_IDLE_TIMEOUT_MS })
} else {
  setTimeout(prewarmFontList, FONT_PREWARM_IDLE_TIMEOUT_MS)
}
