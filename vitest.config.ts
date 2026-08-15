import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'

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
    // U-P2-21 coverage 纳管；G4-1（2026-08-16）引入全局阈值门 = 基线 −2pp 向下取整（防回退不追高）。
    // 基线快照 2026-08-16：statements 84.43 / branches 80.96 / functions 95 / lines 84.43。
    // web-next 是独立前端工程（自有 vue-tsc/构建链），不入本仓库内核口径。
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/studio/web-next/**', 'src/**/*.d.ts'],
      thresholds: {
        statements: 82,
        branches: 78,
        functions: 93,
        lines: 82,
      },
    },
  },
})
