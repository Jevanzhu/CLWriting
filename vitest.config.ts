import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'

// pinia 只装在 web 子包（src/studio/web/node_modules），根 node_modules 没有。
// alias 过去让测试文件能解析 'pinia'，并保证测试与页面组件共享同一 Pinia 实例。
const webPinia = fileURLToPath(
  new URL('./src/studio/web/node_modules/pinia', import.meta.url),
)

export default defineConfig({
  // vitest 需显式挂 plugin-vue 才能处理 .vue 文件。
  plugins: [vue()],
  resolve: {
    alias: {
      pinia: webPinia,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // 排除 macOS 外置卷自动生成的 ._ AppleDouble 元数据文件
    exclude: ['**/node_modules/**', '**/._*'],
    environment: 'node',
    testTimeout: 30000,
  },
})
