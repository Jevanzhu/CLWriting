import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { COVERAGE_EXCLUDE, COVERAGE_INCLUDE, COVERAGE_THRESHOLDS } from './vitest.coverage-buckets.js'

const rootPinia = fileURLToPath(new URL('./node_modules/pinia', import.meta.url))
const rootVue = fileURLToPath(new URL('./node_modules/vue', import.meta.url))
const rootVueReactivity = fileURLToPath(new URL('./node_modules/@vue/reactivity', import.meta.url))
const rootVueRuntimeCore = fileURLToPath(new URL('./node_modules/@vue/runtime-core', import.meta.url))
const rootVueRuntimeDom = fileURLToPath(new URL('./node_modules/@vue/runtime-dom', import.meta.url))
const rootVueShared = fileURLToPath(new URL('./node_modules/@vue/shared', import.meta.url))

// CodeMirror 家族安装在 web-next 嵌套 node_modules（根测试目录解析不到）——钉到
// 实际位置，供 CmHost 真实扩展（打字机回归等）做单元测试；各包自身依赖从其真实
// 路径向上解析即可，只钉测试直接 import 的入口。
const cmBase = './src/studio/web-next/node_modules/'
const cmState = fileURLToPath(new URL(`${cmBase}@codemirror/state`, import.meta.url))
const cmView = fileURLToPath(new URL(`${cmBase}@codemirror/view`, import.meta.url))
// vue-router 同嵌套布局——web-next 自带副本，根目录测试对裸名
// 'vue-router' 的解析与 vi.mock 裸名都钉到该副本；此前测试 mock 钉嵌套路径字符串，
// 依赖提升布局一变 mock 不命中、连锁挂（alias 让布局变化只在配置处消化一次）。
const webNextVueRouter = fileURLToPath(new URL(`${cmBase}vue-router`, import.meta.url))

// 排除 macOS 外置卷自动生成的 ._ AppleDouble 元数据文件
const EXCLUDE = ['**/node_modules/**', '**/._*']
// DOM 测试面：整目录承载 happy-dom 环境（原逐档头注，见 test 块头注）
const DOM_FILES = ['test/studio/webnext/dom/**/*.test.ts']
// 两个运行环境项目逐项重复的共享档（v5 对 projects 的继承是部分的，故显式展开）。
// 内存闸：默认按 CPU 数 fork（本机 8-10 worker）× 大负载测试
// （rag/scale、check/scale 各自 GB 级峰值）叠加出过 19GB 总占用（机器 16GB 爆内存）；
// 限到 4 并发压峰值（CPU 核多时不再全开）。
// CI 再压到 2——GitHub runner（ubuntu/macos 均 ~7GB）比本机
// 16GB 更紧，4 fork × GB 级 scale 峰值在 CI 侧无实测背书、OOM 风险单向；2 并发
// 峰值减半换时长（20 分钟预算内），本地维持 4。
// （阶段 39）：poolOptions.* 整体移除——并发上限改顶层 maxWorkers；
// minForks 无对应键（v5 自管最小并发）。旧 poolOptions 键在 v5 只发 DEPRECATED
// 警告并静默失效（内存闸失守一轮实测在案），勿回填。
// GET /api/* 读端点要求 token——setup 统一给测试内 fetch 的 GET 请求注入
// x-studio-token（按 origin 缓存 boot token），存量测试无需逐个补头。
// 阶段 53：第二个 setup 关掉起服后延迟触发的更新检查（测试不打网的硬要求，
// 见 test/helpers/disable-update-check-setup.ts 头注）。
// 全局 30s 是常规单测兜底，不是大负载用例的预算——GB 级/界值类
// 用例已在文件内显式放宽（test/check/scale.test.ts 与 test/rag/scale.test.ts 的
// it(..., { timeout: 300_000 }, ...)），全局值保持不动；新增大负载用例请在用例级
// 显式放宽，勿上调全局值（上调会掩盖常规用例的挂死回归）。
// v5 里 poolOptions 已整体移除，worker 的 Node 启动参数唯一入口是顶层
// test.execArgv（projects 内亦可，ProjectConfig = Omit<InlineConfig, NonProjectOptions>，
// 该键未被非项目键排除；实现侧并入 fork/Worker 的 execArgv 选项）。
// --expose-gc：内存滞留回归档（test/check/tree-issues-cache-close-pair.test.ts 与
// test/rag/rag-prepared-cache-release.test.ts 的 gc 门控用例）靠 globalThis.gc 量堆增长，
// 不注入则本地与 CI 全量永久 skip —— 这类档一旦只能 skip 就是零守护（回退了也无人报警）。
// 全 worker 常开而非只对两个档：vitest 的 execArgv 是项目级键，无逐档粒度。
const SHARED = {
  pool: 'forks' as const,
  maxWorkers: process.env.CI ? 2 : 4,
  execArgv: ['--expose-gc'],
  setupFiles: ['test/helpers/studio-token-setup.ts', 'test/helpers/disable-update-check-setup.ts'],
  testTimeout: 30000,
}

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
    // ── 运行环境按目录路由（v5 projects）──────────────────────────────────
    // 背景：前端测试面原在 213 个档里逐文件写 `@vitest-environment happy-dom` 头注，
    // 漏写即按 node 跑而假红（DOM 全局缺失）；头注本身也是纪律负担。现改为
    // `test/studio/webnext/dom/**` 整目录走 happy-dom，其余全部 node——环境由目录
    // 结构承载，加档只需落对目录，不再有「忘写一行」的失败形态。
    //
    // 分桶依据就是原头注本身（迁移无判断成分）：213 档带头注 → dom/，78 档无 → node。
    //
    // 实现取舍：项目条目**保留默认继承**（不写 `extends: false`）——`extends: false` 会
    // 连同本档 resolve.alias / plugins 一并丢掉，web-next 的 store 与测试会各自解析到
    // 两份 pinia（vite 嵌套 node_modules），`setActivePinia` 与 `useStore` 不在同一副本上，
    // 全量假红（本批实测在案）。继承之下仍需逐项重复 testTimeout 等不继承项，理由见上。
    // 共享项集中在 SHARED 对象里单源，重复由展开承担，改一处即两处生效。
    //
    // `--project <name>` / 直接传文件路径过滤均可用（单档直跑的纪律不受影响；
    // 单档过滤时该档落在自己所属项目里跑，环境正确）。
    include: [],
    exclude: EXCLUDE,
    ...SHARED,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          // dom 子树交给 dom 项目——include 在多项目间是并集，路由只能靠 exclude 表达
          exclude: [...EXCLUDE, ...DOM_FILES],
          environment: 'node',
          ...SHARED,
        },
      },
      {
        test: { name: 'dom', include: [...DOM_FILES], exclude: EXCLUDE, environment: 'happy-dom', ...SHARED },
      },
    ],
    // coverage 纳管；引入全局阈值门 = 基线 −2pp 向下取整（防回退不追高）。
    // 基线快照：statements 84.43 / branches 80.96 / functions 95 / lines 84.43。
    // coverage/coverage-summary.json（含 html/）是「分桶局部跑」产物——
    // 只反映当次跑到的文件子集，其 total（如 api 桶局部跑的 89.32%）不可解读为全书
    // 覆盖率；全书口径只在全量跑后读各桶阈值行。该目录未入 git（纯本地构建产物），
    // 无入库清理问题。
    // web-next 前端逻辑层（stores/composables/shared/api，纯 .ts）
    // 纳入报告与门禁——per-glob 三桶不重叠分区（glob 键按 picomatch 段级否定切分；
    // 匹配多桶的文件须过所有桶，故主代码不能再用 src/** 全量键）；无扁平键 = 全局桶跳过。
    // web-next 门 =实测基线（lines 45.08 / branches 83.54）−2pp 向下取整，
    // 只防回退不追高；.vue 组件层仍不入口径（vue-tsc/构建链自管）。
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // vitest 3.2.7 默认 coverage.reportOnFailure=false——用例红时
      // 不产出报告目录，CI 工件化在阈值红+用例红形态都无现场可传。显式
      // 打开：报告产出与测试成败解耦，红了也有 html/json-summary 可查。
      reportOnFailure: true,
      // include 不含 scripts/*.ts 属有意取舍——
      // scripts 面由 tsc/eslint/直测（test/scripts/）覆盖，coverage 盲区为接受项，勿当遗漏补
      // include 扩入 web-next SFC——'src/studio/web-next/src/**/*.vue'
      // 精确限定 web-next src 子树（全仓 110 个 .vue 均在此，根 src 与别处无 .vue，不会扫入）；
      // SFC script 块经 plugin-vue 转换后 v8 可产数（见本批实验记录），组件层入核算。
      include: [...COVERAGE_INCLUDE],
      exclude: [...COVERAGE_EXCLUDE],
      thresholds: COVERAGE_THRESHOLDS,
    },
  },
})
