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
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:18999',
    headless: true,
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
