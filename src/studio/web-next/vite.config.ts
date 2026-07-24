import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// web-next：M10 Obsidian 风前端重写（T4.3 已切为唯一前端，旧 src/studio/web 删除）。
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
    // dev 时 /api 代理到后端（dev:api 固定 7878）
    proxy: {
      '/api': 'http://127.0.0.1:7878',
    },
  },
})
