import { defineConfig } from '@playwright/test'
// R73-75（批 F-8）：baseURL 与 global-setup 主 server 同源——端口族统一从
// CLW_E2E_PORT_BASE（缺省 18999）派生，定义见 test/e2e/e2e-ports.ts（含偏移表）
import { E2E_PORT_BASE } from './test/e2e/e2e-ports.js'

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
  // R65-59（F-3）：CI 上拒绝 test.only——与 vitest 侧同款运行期兜底
  forbidOnly: !!process.env.CI,
  // R71-38（总七十一轮）：改死 retries: 0（撤 R65-62 的 CI 重试 1 次）——e2e 共享单一
  // 临时 workDir 的顺序契约（前序 spec 落盘是后序输入，E2E_SPEC_ORDER_SNAPSHOT 守卫
  // 保护）下，CI 重试会重放失败 spec 的副作用：洗绿失败的同时可能污染下游 spec 的
  // 输入。偶发 flake 将直接红、需人工重跑——这是顺序契约下的正确取舍
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    // R73-75：端口基址派生（CLW_E2E_PORT_BASE，缺省 18999 与历史硬编码一致）
    baseURL: `http://127.0.0.1:${E2E_PORT_BASE}`,
    headless: true,
    actionTimeout: 10_000,
    // dd-P3（E-P3-1）：失败留 trace——CI 已有 failure 上传 test-results/ 步骤，
    // 不录 trace 时该工件是空目录，失败只能靠日志猜
    trace: 'retain-on-failure',
  },
  // R73-76（批 F-9）：首因标记——顺序契约下 spec 崩溃会让下游连坐红，整轮第一个
  // 未通过用例即首因，reporter 打印提示不改结果（list 保持默认输出）
  reporter: [['list'], ['./test/e2e/first-cause-reporter.ts']],
  projects: [
    // R73-74（批 F）：维持单 chromium 腿——Electron=Chromium 同核；补 webkit/firefox
    // 需另装浏览器且 dev:web 形态非发布面，登记取舍不在本轮扩腿
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
