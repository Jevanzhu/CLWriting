import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'

const webVueRouter = fileURLToPath(
  new URL('./src/studio/web/node_modules/vue-router', import.meta.url),
)
const rootPinia = fileURLToPath(new URL('./node_modules/pinia', import.meta.url))
const rootVue = fileURLToPath(new URL('./node_modules/vue', import.meta.url))
const rootVueReactivity = fileURLToPath(
  new URL('./node_modules/@vue/reactivity', import.meta.url),
)
const rootVueRuntimeCore = fileURLToPath(
  new URL('./node_modules/@vue/runtime-core', import.meta.url),
)
const rootVueRuntimeDom = fileURLToPath(
  new URL('./node_modules/@vue/runtime-dom', import.meta.url),
)
const rootVueShared = fileURLToPath(new URL('./node_modules/@vue/shared', import.meta.url))

export default defineConfig({
  // vitest 需显式挂 plugin-vue 才能处理 .vue 文件。
  plugins: [vue()],
  resolve: {
    alias: {
      pinia: rootPinia,
      'vue-router': webVueRouter,
      vue: rootVue,
      '@vue/reactivity': rootVueReactivity,
      '@vue/runtime-core': rootVueRuntimeCore,
      '@vue/runtime-dom': rootVueRuntimeDom,
      '@vue/shared': rootVueShared,
    },
    dedupe: ['vue', '@vue/reactivity', '@vue/runtime-core', '@vue/runtime-dom', '@vue/shared'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    // 排除 macOS 外置卷自动生成的 ._ AppleDouble 元数据文件
    exclude: ['**/node_modules/**', '**/._*'],
    environment: 'node',
    testTimeout: 30000,
  },
})
