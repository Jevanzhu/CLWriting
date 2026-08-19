/**
 * 三审 e2e（M12 块1 B1.4）：选章 → 审阅 tab → 三审 → 出 mock 意见。
 *
 * mock driver 按 review role 返固定 issues JSON（B1.4 分发），三审面板渲染警告项。
 * 断网态置灰由 ai-degrade.spec 模式覆盖（aiOff 逻辑在 ReviewPanel 单测/手测）。
 */
import { test, expect } from '@playwright/test'

test('三审：选章 → 审阅 tab → 三审 → 出 mock 意见', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText('初入宗门').first().click()
  // kk 观察：CI 慢速 runner 冷启挂载可超默认 10s，编辑器挂载断言统一放宽（见 check.spec 注）
  await expect(page.locator('.cm-content')).toBeVisible({ timeout: 20_000 })

  // 切右栏「审阅」tab（FileSearch 图标，第2个 .right-tab：信息/审阅/机检/分析）
  await page.locator('.right-tabs .right-tab').nth(1).click()
  // 点「三审」按钮
  await page.locator('.rev-run-btn').click()
  // mock 三审（submit_issues 契约）3 lens 串行产 issues → 面板渲染警告项（含 mock issue 文案）
  await expect(page.locator('.review-panel .rev-item--yellow').first()).toContainText('mock 问题', {
    timeout: 15_000,
  })

  // verdict（B1.3 方案 A）：点「通过」→ 徽章显「通过」（落 review 信封，aiOff 不置灰）
  await expect(page.locator('.review-panel .rev-verdict-badge')).toHaveText('待审')
  await page.locator('.review-panel .rev-verdict-btn').first().click()
  await expect(page.locator('.review-panel .rev-verdict-badge')).toHaveText('通过')
})
