import { defineConfig } from '@playwright/test'
// （批）：baseURL 与 global-setup 主 server 同源——端口族统一从
// CLW_E2E_PORT_BASE（缺省 18999）派生，定义见 test/e2e/e2e-ports.ts（含偏移表）
import { E2E_PORT_BASE } from './test/e2e/e2e-ports.js'

// 阶段 53 ：e2e 不打网闸——关掉起服后延迟触发的更新检查（会出站访问 api.github.com）。
// 落点在配置模块加载期：Playwright 的 worker 进程继承本进程 env，故 global-setup 的主
// server 与各 spec 自起的 server（test/e2e/e2e-ports.ts 偏移族）一并覆盖，无需逐 spec 注入。
process.env['CLW_DISABLE_UPDATE_CHECK'] = '1'

/**
 * e2e 配置（#13.1）：globalSetup 起 studio server（mock driver + 双轨 fixture + dist/web 静态托管），
 * 测访问 baseURL 跑关键路径。mock driver 不调大模型（CLWRITING_DRIVER=mock）。
 *
 * 跑：npm run test:e2e（先 build:web 产 dist/web，再 playwright test）。
 */
export default defineConfig({
  testDir: './test/e2e',
  // 顺序契约守卫 test/e2e/spec-order.guard.test.ts 是 vitest 用例
  // （注释宣称的 E2E_SPEC_ORDER_SNAPSHOT 此前是幻影，本轮落地），但 *.test.ts
  // 会命中 Playwright 默认 testMatch——不排除它会被收进 spec 集，破坏 spec 顺序契约
  // （现 33 spec；spec-order.snapshot.txt 快照 = 机检真值，注释计数不承重）。
  // 从单点豁免泛化为「Playwright 只认 *.spec.ts」——e2e 目录里的
  // vitest 单测（guard / 端口偏移断言等）每加一个都要补豁免不可持续，且漏补
  // 的形态是 runner 级崩溃（vitest import 在 playwright 进程无内部状态可访问），
  // 整轮 e2e 静默没跑（管道 tail 还会掩盖退出码），比 spec 顺序契约破坏更隐蔽
  testIgnore: '**/*.test.ts',
  globalSetup: './test/e2e/global-setup.ts',
  // e2e 共享 globalSetup 的单一 workDir/server，必须串行跑避免 test 间磁盘并行污染
  workers: 1,
  // CI 上拒绝 test.only——与 vitest 侧同款运行期兜底
  forbidOnly: !!process.env.CI,
  // （总七十一轮）：改死 retries: 0（撤 的 CI 重试 1 次）——e2e 共享单一
  // 临时 workDir 的顺序契约（前序 spec 落盘是后序输入，E2E_SPEC_ORDER_SNAPSHOT 守卫
  // 保护——守卫实体落在 test/e2e/spec-order.guard.test.ts，vitest 侧跑）下，
  // CI 重试会重放失败 spec 的副作用：洗绿失败的同时可能污染下游 spec 的
  // 输入。偶发 flake 将直接红、需人工重跑——这是顺序契约下的正确取舍
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    // 端口基址派生（CLW_E2E_PORT_BASE，缺省 18999 与历史硬编码一致）
    baseURL: `http://127.0.0.1:${E2E_PORT_BASE}`,
    headless: true,
    actionTimeout: 10_000,
    // dd-失败留 trace——CI 已有 failure 上传 test-results/ 步骤，
    // 不录 trace 时该工件是空目录，失败只能靠日志猜
    trace: 'retain-on-failure',
  },
  // （批）：首因标记——顺序契约下 spec 崩溃会让下游连坐红，整轮第一个
  // 未通过用例即首因，reporter 打印提示不改结果（list 保持默认输出）
  // （GLM-5.3 修复批）：顺序契约运行期探针——
  // onBegin 拿 Playwright 自排计划执行序对 spec-order.snapshot.txt 比对，镜像假设
  //（guard 用 localeCompare 镜像收集序）分叉当场红；与 vitest 侧守卫互补合围
  reporter: [['list'], ['./test/e2e/first-cause-reporter.ts'], ['./test/e2e/spec-order.reporter.ts']],
  projects: [
    // 维持单 chromium 腿——Electron=Chromium 同核；补 webkit/firefox
    // 需另装浏览器且 dev:web 形态非发布面，登记取舍不在本轮扩腿
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
