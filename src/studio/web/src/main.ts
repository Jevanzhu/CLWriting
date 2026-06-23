import { createApp } from 'vue'
import App from './App.vue'
import router from './router'

// P0 session token(GPT-5 defense-in-depth):写端点校验,防跨站伪造。
// 启动 fetch /api/boot 拿 token,所有 /api/ 请求自动带 X-Studio-Token header。
let studioToken = ''
const originalFetch = window.fetch
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (studioToken) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url.includes('/api/')) {
      const headers = new Headers(init?.headers)
      headers.set('X-Studio-Token', studioToken)
      init = { ...init, headers }
    }
  }
  return originalFetch(input as RequestInfo, init)
}
void fetch('/api/boot')
  .then((r) => r.json())
  .then((d: { token?: string }) => {
    studioToken = d.token ?? ''
  })

createApp(App).use(router).mount('#app')
