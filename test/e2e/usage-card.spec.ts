/**
 * D1（批 4）用量卡片 e2e：开书默认进工作台 → 「AI 用量」卡可见
 * （空书无记录 → 空态文案；有记录 → 表格 + 未配价引导，金额口径不在 e2e 断言面）。
 */
import { test, expect } from '@playwright/test'

test('用量卡：工作台视图展示「AI 用量」卡（D1）', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  // 开书默认进编辑器视图 → ribbon 切「工作台」
  await page.getByRole('button', { name: '工作台' }).click()
  // CI 慢速 runner 挂载放宽（与 check.spec 同口径）
  await expect(page.locator('.usage-card')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.usage-card .usage-title')).toContainText('AI 用量')
  // 空书：要么空态文案、要么表格（fixture 书可能有历史事件库记录，两态都合法）
  const empty = await page.locator('.usage-card .usage-empty').count()
  const table = await page.locator('.usage-card table').count()
  expect(empty + table).toBeGreaterThan(0)
})
