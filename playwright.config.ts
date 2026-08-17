import { defineConfig } from '@playwright/test'

/**
 * e2e 配置（#13.1）：globalSetup 起 studio server（mock driver + 双轨 fixture + dist/web 静态托管），
 * 测访问 baseURL 跑关键路径。mock driver 不调大模型（CLWRITING_DRIVER=mock）。
 *
 * 跑：npm run test:e2e（先 build:web 产 dist/web，再 playwright test）。
 */
export default defineConfig({
  testDir: './test/e2e',
  globalSetup: './test/e2e/global-setup.ts',
  // e2e 共享 globalSetup 的单一 workDir/server，必须串行跑避免 test 间磁盘并行污染
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:18999',
    headless: true,
    actionTimeout: 10_000,
    // dd-P3（E-P3-1）：失败留 trace——CI 已有 failure 上传 test-results/ 步骤，
    // 不录 trace 时该工件是空目录，失败只能靠日志猜
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
