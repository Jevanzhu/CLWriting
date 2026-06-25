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
        // vendor 拆包(P2 前端首包优化):图表/编辑器按内部边界拆,避免单个懒加载块过大。
        manualChunks(id) {
          if (
            id.includes('node_modules/vue') ||
            id.includes('node_modules/@vue') ||
            id.includes('node_modules/pinia') ||
            id.includes('node_modules/vue-router')
          ) {
            return 'vue-vendor'
          }
          if (
            id.includes('node_modules/naive-ui') ||
            id.includes('node_modules/@css-render') ||
            id.includes('node_modules/css-render') ||
            id.includes('node_modules/vdirs') ||
            id.includes('node_modules/vooks') ||
            id.includes('node_modules/treemate')
          ) {
            return 'naive-ui'
          }
          if (id.includes('node_modules/zrender')) return 'zrender'
          if (id.includes('node_modules/echarts/lib/chart')) return 'echarts-charts'
          if (id.includes('node_modules/echarts/lib/component') || id.includes('node_modules/echarts/lib/coord')) {
            return 'echarts-components'
          }
          if (id.includes('node_modules/echarts')) return 'echarts-core'
          if (id.includes('node_modules/@codemirror/view')) return 'cm-view'
          if (id.includes('node_modules/@codemirror/state')) return 'cm-state'
          if (id.includes('node_modules/@codemirror/lang-markdown')) return 'cm-markdown'
          if (id.includes('node_modules/@codemirror/language') || id.includes('node_modules/@lezer')) return 'cm-language'
          if (id.includes('node_modules/@codemirror/autocomplete')) return 'cm-autocomplete'
          if (id.includes('node_modules/@codemirror/commands')) return 'cm-commands'
          if (id.includes('node_modules/@codemirror/search')) return 'cm-search'
          if (id.includes('node_modules/@codemirror/lint')) return 'cm-lint'
          if (id.includes('node_modules/@codemirror') || id.includes('node_modules/codemirror')) return 'cm-addons'
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
