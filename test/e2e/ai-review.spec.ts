/**
 * 三审 e2e（M12 块1 B1.4）：选章 → 审阅 tab → 三审 → 出 mock 意见。
 *
 * mock driver 按 review role 返固定 issues JSON（B1.4 分发），三审面板渲染警告项。
 * 断网态置灰由 ai-degrade.spec 模式覆盖（aiOff 逻辑在 ReviewPanel 单测/手测）。
 */
import { test, expect } from '@playwright/test'

test('三审：选章 → 审阅 tab → 三审 → 出 mock 意见', async ({ page }) => {
  await page.goto('/')
  await page.getByText('长篇测试书', { exact: true }).click()
  await page.getByText('初入宗门').first().click()
  await expect(page.locator('.cm-content')).toBeVisible()

  // 切右栏「审阅」tab（FileSearch 图标，第2个 .right-tab：信息/审阅/机检/分析）
  await page.locator('.right-tab').nth(1).click()
  // 点「三审」按钮
  await page.locator('.rev-run-btn').click()
  // mock driver 3 lens 串行产 issues → 面板渲染警告项（含「mock 三审」文案）
  await expect(page.locator('.review-panel .rev-item--yellow').first()).toContainText('mock 三审', {
    timeout: 15_000,
  })
})
