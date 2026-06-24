import { defineConfig } from '@playwright/test'

/**
 * Studio 真宿主 e2e smoke。
 *
 * 与默认 e2e 隔离：默认 `test:e2e` 仍走 mock driver；此配置显式启动
 * CC 真 driver，会调用本机 `claude`，用于人工 release/preflight 验收。
 */
export default defineConfig({
  testDir: './test/e2e-true-host',
  globalSetup: './test/e2e-true-host/global-setup.ts',
  timeout: 360_000,
  expect: { timeout: 300_000 },
  use: {
    baseURL: 'http://127.0.0.1:19001',
    headless: true,
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
