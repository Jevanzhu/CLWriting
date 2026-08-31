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
    // R67-21（十五轮）：CI 再压到 2——GitHub runner（ubuntu/macos 均 ~7GB）比本机
    // 16GB 更紧，4 fork × GB 级 scale 峰值在 CI 侧无实测背书、OOM 风险单向；2 并发
    // 峰值减半换时长（20 分钟预算内），本地维持 4。
    pool: 'forks',
    poolOptions: { forks: { maxForks: process.env.CI ? 2 : 4, minForks: 1 } },
    // 排除 macOS 外置卷自动生成的 ._ AppleDouble 元数据文件
    exclude: ['**/node_modules/**', '**/._*'],
    environment: 'node',
    // T2-3：GET /api/* 读端点要求 token——setup 统一给测试内 fetch 的 GET 请求注入
    // x-studio-token（按 origin 缓存 boot token），存量测试无需逐个补头。
    setupFiles: ['test/helpers/studio-token-setup.ts'],
    // R73-77（批 F-7）：全局 30s 是常规单测兜底，不是大负载用例的预算——GB 级/界值类
    // 用例已在文件内显式放宽（test/check/scale.test.ts 与 test/rag/scale.test.ts 的
    // it(..., { timeout: 300_000 }, ...)），全局值保持不动；新增大负载用例请在用例级
    // 显式放宽，勿上调全局值（上调会掩盖常规用例的挂死回归）。
    testTimeout: 30000,
    // U-P2-21 coverage 纳管；G4-1（2026-08-16）引入全局阈值门 = 基线 −2pp 向下取整（防回退不追高）。
    // 基线快照 2026-08-16：statements 84.43 / branches 80.96 / functions 95 / lines 84.43。
    // R73-72（批 F-6）：coverage/coverage-summary.json（含 html/）是「分桶局部跑」产物——
    // 只反映当次跑到的文件子集，其 total（如 api 桶局部跑的 89.32%）不可解读为全书
    // 覆盖率；全书口径只在全量跑后读各桶阈值行。该目录未入 git（纯本地构建产物），
    // 无入库清理问题。
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
      // R33D-36（三十三轮）：vite.config.ts 入 exclude（进报告无阈值桶的桶外暗区收口）
      exclude: ['src/**/*.d.ts', 'src/studio/web-next/vite.config.ts', 'src/studio/web-next/src/{components,types}/**', 'src/studio/web-next/src/{main,router}.ts'],
      thresholds: {
        // 主代码单桶（brace+extglob 组合 = 除 web-next 外的全部，池化口径与旧全局门一致；
        // 首次实测 2026-08-20：lines 89.45 / branches 82.89 / functions 95.9）
        'src/{!(studio),studio/!(web-next)}/**': { statements: 82, branches: 78, functions: 93, lines: 82 },
        // R66-41（十四轮）：主桶上叠三个域级子桶——聚合均值仍可稀释新增低覆盖文件
        //（主桶池化 ~90% 均值，新文件 10% 也推不动门）；vitest 多桶语义为「匹配多桶的
        // 文件须过所有桶」，子桶与主桶并存 = 域级基线门叠加全局防回退门，两不误。
        // 阈值 = 2026-08-27 实测基线 −2pp 向下取整（coverage-summary.json 全量重算）：
        // ai 90.76/86.81/97.04 · events 97.25/92.14/100 · studio/server 88.24/71.51/94.43
        'src/ai/**': { statements: 88, branches: 84, functions: 95, lines: 88 },
        'src/events/**': { statements: 95, branches: 90, functions: 98, lines: 95 },
        'src/studio/server/**': { statements: 86, branches: 69, functions: 92, lines: 86 },
        // M-7（第十轮）：api 层单列覆盖桶——此前十余 api 文件落进聚合桶被 stores 高覆盖
        // 均值掩盖（单文件回退对阈值门不可见，参数/响应映射逻辑零守护）；阈值 = 实测基线
        // −2pp 向下取整，只防回退不追高。X-6（第五十六轮批 D）：批 A 补 api 直测后
        // 2026-08-24 实测 lines 25.17 / branches 88.77。R67-5（十五轮）：本轮再收基线——
        // 2026-08-27 全量 coverage-summary 实测 lines 36.87 / branches 90.35，门收到
        // 34 / 88（−2pp 向下取整；lines 自 23 提 11pp，注释自认的「待收紧」销账）。
        // G-2（二十轮）：api-endpoints-a/b 两文件补 16 域行为级直测（37 用例：URL 编码/
        // method/body 负载/响应解包/404 兜底），2026-08-28 实测 lines 89.32 / branches
        // 95.83，门提到 87 / 93（同 −2pp 规则）
        'src/studio/web-next/src/api/**': { lines: 87, branches: 93 },
        // R62-23：editor/ 并入——typewriter.ts（运行时逻辑 19 行）此前不落任何桶，
        // 进报告却是「桶外暗区」；并入三桶后纳入门禁（阈值不变）
        'src/studio/web-next/src/{composables,editor,shared,stores}/**': { lines: 43, branches: 81 },
        // R29-12（二十九轮批 F）：stores 单列子桶——stores（纯逻辑层，实测最厚）此前与
        // composables（实测 lines 76.70）同池，域内回退被聚合均值稀释、对门不可见；
        // 阈值 = 2026-08-30 全量 coverage-summary 实测基线（lines 91.82 / branches
        // 90.20）−2pp 向下取整 → 89 / 88，远高于 43% 总门 → 拆桶条件成立（评估结论见
        // 总览 R29-12）。原聚合桶 glob/阈值维持不动，沿用「匹配多桶的文件须过所有桶」
        // 语义：stores 文件同过域级基线门 + 聚合防回退门，两不误。
        'src/studio/web-next/src/stores/**': { lines: 89, branches: 88 },
      },
    },
  },
})
