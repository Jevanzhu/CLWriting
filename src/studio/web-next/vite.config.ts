import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// dev-api 端口单源（根 src/shared/contract 跨包契约底座）——代理目标与 SSE dev 直连基址
// （src/composables/useSse.ts）、服务端缺省端口同源，换端口只改单源一处。
import { DEV_API_DEFAULT_PORT } from '../../shared/contract/studio.js'

const here = dirname(fileURLToPath(import.meta.url))

// web-next：M10 前端重写（T4.3 已切为唯一前端，旧 src/studio/web 删除）。
// 构建产物输出 dist/web（服务端 staticDir / Electron 生产模式消费）。dev 占 5173
// （服务端 CORS 白名单只放行 5173）。
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: join(here, '..', '..', '..', 'dist', 'web'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // dev 时 /api 代理到后端（dev:api 缺省端口，值单源见上方 import）
    proxy: {
      '/api': `http://127.0.0.1:${DEV_API_DEFAULT_PORT}`,
    },
  },
})
