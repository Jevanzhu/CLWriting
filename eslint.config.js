/**
 * 最小 lint 门——项目此前无任何 lint/format 门禁，风格一致性零机器约束。
 * 本配置刻意从简：只上 no-unused-vars / no-undef 两条零争议规则，覆盖 eslint 核心可
 * 直接解析的 JS/MJS 面（scripts/*.mjs + 本配置）。
 *
 * TS 面接入——typescript-eslint 预装后扩 src 下 .ts 块（此前 espree 不认 TS 语法，
 * CI lint 步对 TS 零约束近乎空转）。规则起步＝ recommended 预设，报红量大且低价值的
 * 规则逐条关掉（每条配中文理由，见下）。射程登记：vue 面（web-next 子包独立自治 +
 * .vue SFC）本轮不动。scripts 目录 .ts 接入（实测 9 文件 0 错，零修复纳管）。
 * test 目录接入——扩进 TS 块 files（与 src/scripts 同规则族，规则表逐位未动），
 * 存量 45 错机械清偿（31 处 no-explicit-any + 14 处 no-unused-vars，实测口径）；
 * 其中 no-explicit-any 后续单独降档（三十轮末降 warn → 降 off，见下方 test 块）。
 * test/ 侧 no-explicit-any 显式降为 off——31 处存量 warning 归零，此后 `npx eslint .`
 * 口径为 0 error / 0 warning。
 *
 * 类型感知层与 .vue 面接入（质量债 P3-4 批 6）：
 * - 此前 TS 块无 parserOptions.project，`no-floating-promises` 一族类型感知规则根本
 *   不可用——而本仓 fire-and-forget（`void runSelfHeal(...)`）与未 await 的 Promise
 *   写法很常见，正是最该由机器兜底的一类。现接双 tsconfig 工程（根 + web-next 子包），
 *   实测 1941 文件解析零失败。
 * - .vue SFC 此前完全在 lint 射程外（只由 vue-tsc 管类型）；现接 eslint-plugin-vue
 *   essential 档 + 脚本块走 tseslint.parser，SFC 模板面的正确性规则生效。
 * - 存量违规用 ESLint 批量抑制（`eslint-suppressions.json`，键 = 文件 + 规则 + 计数）
 *   冻结：规则一律 error，新增即报红，存量不动——即报告建议的「先 warn 只卡新增」
 *   的等价严形态（比 warn 更紧：warn 会被噪音淹没，计数抑制只放行已登记的那些）。
 *   改动存量代码使某规则命中数下降后再新增同规则违规，计数仍可能不超——此为计数式
 *   抑制的已知松弛点，如实记档；`npm run lint:prune` 可清理已失效条目。
 * - 复杂度三规则（complexity / max-lines-per-function / max-depth）与其余类型感知规则
 *   只上生产面（src / scripts / 根配置）；test/ 只加 no-floating-promises 与
 *   no-misused-promises 两条——测试替身的宽松 any 面（实测 779 处 unsafe-member-access）
 *   会淹没抑制表，且 tsc 已对 test/ 全量类型检查兜底；未 await 的异步断言则是测试
 *   卫生的真缺陷类，值得收。
 *
 * 跑：npm run lint（= eslint .，按本配置的 files/ignores 圈定范围）。
 * 格式化门（P3-4 另一半）：prettier.config.mjs + .prettierignore，见 npm run format:check。
 */
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'

// recommended 为配置数组（base + eslint-recommended + recommended），手工摊平成纯
// rules 表——保持本文件「无 extends 魔法、数组块直写」的形态与既有块一致
const tsRecommendedRules = tseslint.configs.recommended.reduce((acc, block) => ({ ...acc, ...(block.rules ?? {}) }), {})

/**
 * 类型感知规则表（生产面）。取「真能抓缺陷」的一档，不用 recommendedTypeChecked 全量：
 * 全量里 no-unnecessary-type-assertion 一类风格性条目在存量上就是 547 处，掺进抑制表
 * 只会稀释信号。每条都有明确的缺陷语义：
 * 未处理的 Promise / 误用 / 等待非 Promise / 空 async / 抛非 Error / await 作用域 /
 * 字符串化对象 / 任意类型从边界渗出 / 断言无效 / 方法脱离 this。
 */
const typeAwareRules = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/require-await': 'error',
  '@typescript-eslint/only-throw-error': 'error',
  '@typescript-eslint/prefer-promise-reject-errors': 'error',
  '@typescript-eslint/return-await': 'error',
  '@typescript-eslint/no-base-to-string': 'error',
  '@typescript-eslint/restrict-template-expressions': 'error',
  '@typescript-eslint/unbound-method': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  '@typescript-eslint/no-unsafe-argument': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'error',
  '@typescript-eslint/no-unsafe-call': 'error',
  '@typescript-eslint/no-unsafe-member-access': 'error',
  '@typescript-eslint/no-unsafe-return': 'error',
}

/**
 * 复杂度门（生产面）。阈值对齐评审度量口径（报告按「圈复杂度 > 25」「代码行 > 80」统计
 * 存量分布），存量以计数抑制冻结，新增即刻报红——即「只卡新增」。
 * max-lines-per-function 取 200 且跳过空行与注释：注释密度是本仓特点（全库注释占比
 * 28.8%），按物理行计会把「代码不长但注释详尽」的函数误判为巨型。
 */
const complexityRules = {
  complexity: ['error', 25],
  'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
  'max-depth': ['error', 5],
}

export default [
  {
    // 生成产物与参考资料不入口：coverage/test-results/playwright-report/tmp 为工具输出，
    // dist 为构建产物，Dev/ 为项目文档链（Dev/Docs）+ 第三方参考项目（Dev/参考项目，
    // 均非 lint 射程内的代码面）。
    // web-next 不再整体忽略——TS 面接入 lint 门（原「子包独立自治」口径收窄为
    // 「.vue SFC 仍由 vue-tsc 管」）；工具输出目录保留排除。
    ignores: [
      'dist/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'Dev/**',
      'tmp/**', // 本地脚本临时产物（gates-*.sh/log 等），防未来 .js 入 lint
      'src/studio/web-next/node_modules/**',
      'src/studio/web-next/test-results/**',
      'src/studio/web-next/dist/**',
      'dist-electron/**', // 本地 build:desktop:dir 出包的解包产物（lint 不扫假红；CI 不受影响）
    ],
  },
  {
    // JS/MJS 面（sourceType 统一 module——根 package.json "type": "module"）
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // 手工声明 Node 全局（不引 globals 依赖）：scripts 门禁脚本的运行时面
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Buffer: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        performance: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      // 下划线前缀 = 有意忽略（项目既有惯例，如 (_docId) => …）；catch 形参不追
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
    },
  },
  {
    // TS 面：src 下的 .ts——parser/plugin 用 typescript-eslint；
    // scripts/**/*.ts 增量接入（9 文件 0 错零修复纳管）；
    // test/**/*.ts 增量接入（同规则族，存量 45 错机械清偿）；
    // web-next 随 src/**/*.ts 通配自然纳入（.vue SFC 见下方独立块）
    // 根目录构建配置收编（vitest/playwright/tsup config 此前只受 tsc 管不受 lint 管）
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts', '*.config.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: 'module',
        // 类型感知双工程：根 tsconfig 覆盖 src（除 web-next）+ test + scripts + 根配置；
        // web-next 子包自带 tsconfig（含其 src、vite.config.ts 与 test/studio/webnext）
        project: ['./tsconfig.json', './src/studio/web-next/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // reportUnusedDisableDirectives 回归默认（warn）——存量唯一
    // 失效指令 filename.ts 的 no-control-regex 注释已清（规则本就未启用，指令纯噪声）
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      ...tsRecommendedRules,
      // 下划线前缀 = 有意忽略（对齐本文件 JS 块既有惯例，如 (_input) => …）；
      // catch 形参不追——覆盖 recommended 默认后 6 处存量全清零，规则保持开启
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 存量 9 处 let 违例已随修复批 --fix 清偿，规则开启
      'prefer-const': 'error',
      // 放行空接口：src/driver/types.ts:16 的空接口是既有 driver 扩展点契约
      // （本批禁改 src）；allowInterfaces 后空 type 字面量 `{}` 仍会被拦截
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
      // 生产面才开的类型感知 + 复杂度（test/ 单独降档，见下方流程块）
      ...typeAwareRules,
      ...complexityRules,
    },
  },
  {
    // test/ 目录单规则降档——no-explicit-any 降 off 记档。
    // 理由：存量 31 处同类全落在测试假件语境（studio 假 HTTP 客户端的 `json: any`
    // 载荷 + desktop Electron 假窗口的 `Record<string, any>` 宽松索引面），断言面
    // 52 处动态属性直取，补真类型须对全断言链逐点 cast——非机械改动（>10 同类
    // 阈值），且测试假件本就允许宽松取用。其余规则一律 error 清零。
    // 类型感知只留两条异步卫生规则（未 await / 误用）：测试里漏 await 会让断言比
    // 被测行为先跑完而假绿，属真缺陷类；其余类型感知规则在替身 any 面上会被
    // 779 处 unsafe-member-access 淹没，只留噪音不留信号。
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/return-await': 'off',
      // 复杂度三规则不适用测试文件（describe/it 块天然长）
      complexity: 'off',
      'max-lines-per-function': 'off',
      'max-depth': 'off',
    },
  },
  // .vue SFC 面：essential 档的正确性规则（模板语法错误、v-for key、prop 变异、
  // 重复属性等）——此前 SFC 模板面对 lint 完全不可见。
  ...vue.configs['flat/essential'],
  {
    files: ['src/studio/web-next/**/*.vue'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      parserOptions: {
        // 脚本块（含 lang="ts" 的 <script setup>）交给 tseslint 解析并接类型信息
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        project: ['./src/studio/web-next/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2024,
        sourceType: 'module',
      },
    },
    rules: {
      // 路由级单例视图：组件名即路由身份（Book/Library/Shelf/Welcome），
      // 多词化会与 router 路由名 + 现有文件名约定脱节，故按名单放行
      'vue/multi-word-component-names': [
        'error',
        { ignores: ['Book', 'Library', 'Shelf', 'Welcome', 'Toast', 'Ribbon'] },
      ],
      // 档位草稿按契约以「对象引用与父层共享」传递，子组件 v-model 直接写其字段
      // （不重新赋值 prop 本身）——TierCard 处两处命中属该既有约定，按存量冻结入
      // 抑制表，不因本批改行为（改契约会动到 DOM 与父层草稿语义，超本批射程）
      ...typeAwareRules,
      ...complexityRules,
    },
  },
]
