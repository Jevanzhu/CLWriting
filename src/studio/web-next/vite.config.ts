import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// web-next：M10 Obsidian 风前端重写。与旧 web 二选一启动（同占 5173，
// 因服务端 CORS 白名单只放行 5173）。构建产物暂输出 dist/web-next，
// P4 切挂载时改 dist/web 并删旧 web。
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: join(here, '..', '..', '..', 'dist', 'web-next'),
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
