/**
 * R66-44（十四轮）：最小 lint 门——项目此前无任何 lint/format 门禁（报告 R66-44），
 * 风格一致性零机器约束。本配置刻意从简：只上 no-unused-vars / no-undef 两条
 * 零争议规则，覆盖 eslint 核心可直接解析的 JS/MJS 面（scripts/*.mjs + 本配置）。
 *
 * R74-26（二十二轮 批E）：TS 面接入——typescript-eslint 预装后扩 src 下 .ts 块
 * （此前 espree 不认 TS 语法，CI lint 步对 TS 零约束近乎空转）。规则起步＝
 * recommended 预设，报红量大且低价值的规则逐条关掉（每条配中文理由，见下）。
 * 射程登记：vue 面（web-next 子包独立自治 + .vue SFC）本轮不动；
 * test 目录与 scripts 下 .ts 本轮不接（后续增量）。
 *
 * 刻意不做的：
 * - 风格类规则（引号/分号等）：无 prettier 依赖，不预设口径，避免一次性海量 diff。
 *
 * 跑：npm run lint（= eslint .，按本配置的 files/ignores 圈定范围）。
 */
import tseslint from 'typescript-eslint'

// recommended 为配置数组（base + eslint-recommended + recommended），手工摊平成纯
// rules 表——保持本文件「无 extends 魔法、数组块直写」的形态与既有块一致
const tsRecommendedRules = tseslint.configs.recommended.reduce(
  (acc, block) => ({ ...acc, ...(block.rules ?? {}) }),
  {},
)

export default [
  {
    // 生成产物与参考资料不入口：coverage/test-results/playwright-report 为工具输出，
    // dist 为构建产物，Dev/ 为第三方参考项目（只读语料），web-next 子包独立自治。
    ignores: [
      'dist/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'Dev/**',
      'src/studio/web-next/**',
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
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-undef': 'error',
    },
  },
  {
    // TS 面（R74-26）：src 下的 .ts——parser/plugin 用 typescript-eslint；
    // .vue SFC、test 目录、scripts 下 .ts 本轮不接（头注登记），后续增量扩 files 即可
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: 'module',
      },
    },
    // src/format/filename.ts:63 有一条历史 eslint-disable no-control-regex 指令——
    // 本轮规则集未开 no-control-regex，被上报为 unused directive；本批禁改 src，
    // 故整体关闭该上报（代价：TS 面未来真失效的 disable 指令不再提示）
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
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
      // 关闭：prefer-const 有 9 处存量 let 违例全在 src（本批文件面禁改 src），
      // 修不动故先关门——登记待后续批清掉存量后开启
      'prefer-const': 'off',
      // 放行空接口：src/driver/types.ts:16 的空接口是既有 driver 扩展点契约
      // （本批禁改 src）；allowInterfaces 后空 type 字面量 `{}` 仍会被拦截
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
    },
  },
]

