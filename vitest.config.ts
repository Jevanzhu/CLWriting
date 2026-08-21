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
    // 批 6（2026-08-20 二轮复审）：web-next 前端逻辑层（stores/composables/shared/api，纯 .ts）
    // 纳入报告与门禁——per-glob 三桶不重叠分区（glob 键按 picomatch 段级否定切分；
    // 匹配多桶的文件须过所有桶，故主代码不能再用 src/** 全量键）；无扁平键 = 全局桶跳过。
    // web-next 门 = 2026-08-20 实测基线（lines 45.08 / branches 83.54）−2pp 向下取整，
    // 只防回退不追高；.vue 组件层仍不入口径（vue-tsc/构建链自管）。
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      // 二轮复审（批 5）：web-next/src 顶层 main.ts/router.ts 显式排除——纯应用
      // 引导/路由装配（createApp/use/plug），单测不可达；此前它们不落任何阈值桶
      // 却进报告，分区口径留有「桶外文件」暗区
      exclude: ['src/**/*.d.ts', 'src/studio/web-next/src/{components,types}/**', 'src/studio/web-next/src/{main,router}.ts'],
      thresholds: {
        // 主代码单桶（brace+extglob 组合 = 除 web-next 外的全部，池化口径与旧全局门一致；
        // 首次实测 2026-08-20：lines 89.45 / branches 82.89 / functions 95.9）
        'src/{!(studio),studio/!(web-next)}/**': { statements: 82, branches: 78, functions: 93, lines: 82 },
        'src/studio/web-next/src/{api,composables,shared,stores}/**': { lines: 43, branches: 81 },
      },
    },
  },
})
