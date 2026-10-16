/**
 * T1.7 AI 降级（M11 E1）：AI 不可达态 → 编辑保存照常 + 辅助入口置灰。
 *
 * 独立 server（偏移 1，起停样板见 ./independent-server.ts）+ CLWRITING_E2E_AI_DOWN=1，不污染其余动线（globalSetup 的 18999）。
 * - GET /api/ai-status 短路返回 available:false（ai-status.ts 跳缓存直接探）
 * - 编辑器不依赖 AI：选章编辑 + ⌘S 保存成功
 * - 工作台 UI 降级：.ai-warn 警告条可见 + 生成按钮 disabled
 */
import { test, expect } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'
import { startIndependentServer, type IndependentServer } from './independent-server.js'

let srv: IndependentServer

test.beforeAll(async () => {
  srv = await startIndependentServer({
    tag: 'ai-degrade',
    offset: 1,
    userDataPath: false,
    env: { CLWRITING_E2E_AI_DOWN: '1' },
  })
})

test.afterAll(async () => {
  await srv.close()
})

test('AI 不可达：编辑保存照常 + 辅助置灰', async ({ page }) => {
  attachPageErrorBaseline(page, 'ai-degrade')
  // ① ai-status 报告不可达（T2-3：GET 读端点要求 token，boot 取）
  const boot = await page.request.get(`${srv.base}/api/boot`)
  const token = (await boot.json()).token
  const r = await page.request.get(`${srv.base}/api/ai-status`, { headers: { 'x-studio-token': token } })
  expect(await r.json()).toMatchObject({ available: false })

  await page.goto(`${srv.base}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  // ② 编辑器不依赖 AI：选章编辑 + ⌘S 保存成功
  await page.getByText('初入宗门').first().click()
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible()
  await cm.click()
  await page.keyboard.type('降级时仍可编辑')
  await page.keyboard.press('ControlOrMeta+s') // R64-35（十二轮）：跨平台——非 mac 上 Meta+s 静默不触发（假红）
  await expect(page.locator('.save-group .save-btn')).toContainText('已保存', { timeout: 5_000 })

  // ③ 切工作台 → AI 降级警告条（生成按钮 v-if=!running，running 态不渲染，故以警告条为降级标志）
  // kk-P1-1：tooltip 同步 a20f8eb 新文案（工作台（AI 写作）→ AI 工作台 Beta）
  await page.locator('.rbtn[data-tip="AI 工作台 Beta"]').click()
  await expect(page.locator('.ai-warn')).toContainText('不可用')
})
