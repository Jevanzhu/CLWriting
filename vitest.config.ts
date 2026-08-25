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

// CodeMirror 家族安装在 web-next 嵌套 node_modules（根测试目录解析不到）——钉到
// 实际位置，供 CmHost 真实扩展（打字机回归等）做单元测试；各包自身依赖从其真实
// 路径向上解析即可，只钉测试直接 import 的入口。
const cmBase = './src/studio/web-next/node_modules/'
const cmState = fileURLToPath(new URL(`${cmBase}@codemirror/state`, import.meta.url))
const cmView = fileURLToPath(new URL(`${cmBase}@codemirror/view`, import.meta.url))
// R61-20（第六十一轮）：vue-router 同嵌套布局——web-next 自带副本，根目录测试对裸名
// 'vue-router' 的解析与 vi.mock 裸名都钉到该副本；此前测试 mock 钉嵌套路径字符串，
// 依赖提升布局一变 mock 不命中、连锁挂（alias 让布局变化只在配置处消化一次）。
const webNextVueRouter = fileURLToPath(new URL(`${cmBase}vue-router`, import.meta.url))

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
      '@codemirror/state': cmState,
      '@codemirror/view': cmView,
      'vue-router': webNextVueRouter,
    },
    dedupe: ['vue', '@vue/reactivity', '@vue/runtime-core', '@vue/runtime-dom', '@vue/shared'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    // 内存闸（2026-08-24）：默认按 CPU 数 fork（本机 8-10 worker）× 大负载测试
    // （rag/scale、check/scale 各自 GB 级峰值）叠加出过 19GB 总占用（机器 16GB 爆内存）；
    // forks 池限到 4 并发压峰值（CPU 核多时不再全开）。
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    // 排除 macOS 外置卷自动生成的 ._ AppleDouble 元数据文件
    exclude: ['**/node_modules/**', '**/._*'],
    environment: 'node',
    // T2-3：GET /api/* 读端点要求 token——setup 统一给测试内 fetch 的 GET 请求注入
    // x-studio-token（按 origin 缓存 boot token），存量测试无需逐个补头。
    setupFiles: ['test/helpers/studio-token-setup.ts'],
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
        // M-7（第十轮）：api 层单列覆盖桶——此前十余 api 文件落进聚合桶被 stores 高覆盖
        // 均值掩盖（单文件回退对阈值门不可见，参数/响应映射逻辑零守护）；阈值 = 实测基线
        // −2pp 向下取整，只防回退不追高。X-6（第五十六轮批 D）：批 A 补 api 直测后
        // 2026-08-24 实测 lines 25.17 / branches 88.77——lines 门随本轮基线提到 23
        // （防回退下限，批 A 覆盖只会更高不会更低）；branches 门暂留 67（2026-08-22
        // 基线 69.35 −2pp），主评审收口时可按新基线同步收紧
        'src/studio/web-next/src/api/**': { lines: 23, branches: 67 },
        // R62-23：editor/ 并入——typewriter.ts（运行时逻辑 19 行）此前不落任何桶，
        // 进报告却是「桶外暗区」；并入三桶后纳入门禁（阈值不变）
        'src/studio/web-next/src/{composables,editor,shared,stores}/**': { lines: 43, branches: 81 },
      },
    },
  },
})
