/**
 * 文风收割 e2e（M12 后置）：ribbon 文风收割 → 收割候选 → 勾选 → 入库。
 *
 * learn 规则打分（借 #10 机检）**不涉大模型**——始终可用，不依赖 mock driver。
 * fixture 长篇 0001 正文含 ≥50 字叙事段（样章候选）+「忽然…痛」特征句（金句候选），
 * 确保产合格候选。候选制：作者勾选才入库（learnFromBook 不自动入库）。
 */
import { test, expect } from '@playwright/test'

test('文风收割：收割 → 候选 → 勾选 → 入库', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  // ribbon「文风收割」→ LearnView 渲染
  await page.locator('button[data-tip^="文风收割"]').click()
  await expect(page.locator('.learn-title')).toHaveText('文风收割')

  // 入库按钮初始置灰（pickedCount=0，disabled）
  await expect(page.locator('.learn-actions .btn', { hasText: '入库勾选' })).toBeDisabled()

  // 收割候选（规则打分，POST /learn）
  await page.locator('.learn-actions .btn.primary').click()

  // 样章候选渲染（fixture 0001 有 ≥50 字段落，打分 ≥60）
  await expect(page.locator('.cand-card').first()).toBeVisible({ timeout: 10_000 })

  // 勾选第一篇样章
  await page.locator('.cand-card-head input[type="checkbox"]').first().check()

  // 入库按钮启用 + 文本含勾选数 1
  const commitBtn = page.locator('.learn-actions .btn', { hasText: '入库勾选' })
  await expect(commitBtn).toBeEnabled()
  await expect(commitBtn).toContainText('1')

  // 入库 → 成功提示
  await commitBtn.click()
  await expect(page.locator('.learn-msg')).toContainText('已入库', { timeout: 10_000 })
})
