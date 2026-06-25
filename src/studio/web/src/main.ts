import { createApp } from 'vue'
import naive from 'naive-ui'
import App from './App.vue'
import router from './router'
import { createPinia } from 'pinia'
import { useAppStore } from './stores/app'
import './styles/tokens.css'
import './styles/content.css'

// P0 session token(GPT-5 defense-in-depth):写端点校验,防跨站伪造。
// 启动 fetch /api/boot 拿 token,所有 /api/ 写请求自动带 X-Studio-Token header。
let studioToken = ''
// 写请求等 boot token 就绪再注入(防竞态:boot 未回时写请求 token 空 → 403)。
// 成功/失败都 resolve,避免 boot 异常时写请求永久挂死(此时写会 403,但不卡 UI)。
let bootResolve: () => void = () => {}
const bootReady = new Promise<void>((r) => {
  bootResolve = r
})

const originalFetch = window.fetch
const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE'])
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = (typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url) ?? ''
  // 仅写请求等 token 注入完成(GET 不阻塞,保持读路径即时)
  if (url.includes('/api/') && init?.method && WRITE_METHODS.has(init.method.toUpperCase())) {
    await bootReady
    if (studioToken) {
      const headers = new Headers(init.headers)
      headers.set('X-Studio-Token', studioToken)
      init = { ...init, headers }
    }
  }
  return originalFetch(input as RequestInfo, init)
}

// boot 走 originalFetch(不经 wrapper,GET 无死锁),拿到 token 后放行写请求
void originalFetch('/api/boot')
  .then((r) => r.json())
  .then((d: { token?: string }) => {
    studioToken = d.token ?? ''
  })
  .catch(() => {})
  .finally(bootResolve)

const __app = createApp(App)
__app.use(router).use(createPinia()).use(naive)
useAppStore().applyTheme()  // 启动应用 localStorage 主题（避免闪）
__app.mount('#app')
