/**
 * R66-44（十四轮）：最小 lint 门——项目此前无任何 lint/format 门禁（报告 R66-44），
 * 风格一致性零机器约束。本配置刻意从简：只上 no-unused-vars / no-undef 两条
 * 零争议规则，覆盖 eslint 核心可直接解析的 JS/MJS 面（scripts/*.mjs + 本配置）。
 *
 * 刻意不做的（避免大规模报红 + 不引额外解析依赖）：
 * - TS/Vue 面：espree 解析器不认 TS 语法，接 .ts/.vue 须引 typescript-eslint/
 *   eslint-plugin-vue 全家桶并把 no-unused-vars 换成 TS 感知版——留作后续增量，
 *   TS 侧现有 tsc/vue-tsc 门兜底类型与未用符号（noUnusedLocals 由 tsconfig 管）；
 * - 风格类规则（引号/分号等）：无 prettier 依赖，不预设口径，避免一次性海量 diff。
 *
 * 跑：npm run lint（= eslint .，按本配置的 files/ignores 圈定范围）。
 */
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
]
