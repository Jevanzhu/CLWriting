import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// 前端独立子包（#12.2）：GUI 依赖隔离，不污染主包。
// 构建产物输出到主项目 dist/web/（server 打包后从 dist/web 托管）。
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: join(here, '..', '..', '..', 'dist', 'web'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // vendor 拆包(P2 前端首包优化):echarts/codemirror 大库单独 chunk,主包减负
        manualChunks(id) {
          if (id.includes('node_modules/echarts')) return 'echarts'
          if (id.includes('node_modules/@codemirror') || id.includes('node_modules/codemirror')) return 'codemirror'
          return undefined
        },
      },
    },
  },
  server: {
    port: 5173,
    // dev 时 /api 代理到后端（默认 7878）
    proxy: {
      '/api': 'http://127.0.0.1:7878',
    },
  },
})
