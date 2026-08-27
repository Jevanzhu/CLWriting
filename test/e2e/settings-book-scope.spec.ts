/**
 * 设置页书级覆盖归属（2026-08-27）：纸张宽度/自动保存的「仅本书」入口从全局「编辑器
 * 排版」页移到「本书」页——
 *  - 编辑器排版页：只保留全局默认，不再出现「仅本书」按钮，滑杆绑定全局默认
 *  - 本书页：新增「编辑排版」覆盖组（纸张宽度/自动保存），用「本书独立设定」开关切换书级覆盖
 */
import { test, expect } from '@playwright/test'

test('设置：仅本书入口移本书页 —— 编辑器页无「仅本书」，本书页可开关书级覆盖', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText('初入宗门').first().click()
  await page.locator('.doc-page').waitFor()

  // 打开设置 → 编辑器排版页
  await page.locator('[data-tip="设置（⌘,）"]').click()
  await page.locator('.settings-modal').waitFor()
  await page.locator('.settings-nav button', { hasText: '编辑器排版' }).click()

  // 编辑器页：纸张宽度/自动保存在，但没有「仅本书」按钮（书级入口已移走）
  await expect(page.locator('.settings-content .setting-item-name', { hasText: '纸张宽度' })).toBeVisible()
  await expect(page.locator('.settings-content .setting-item-name', { hasText: '自动保存' })).toBeVisible()
  await expect(page.locator('.settings-content .scope-btn', { hasText: '仅本书' })).toHaveCount(0)

  // 本书页：出现「编辑排版」覆盖组，纸张宽度开关默认关闭（跟随全局默认）
  await page.locator('.settings-nav .nav-book').click()
  await expect(page.locator('.settings-content').getByText('编辑排版')).toBeVisible()
  const pfwSwitch = page.locator('input[aria-label="本书独立设定纸张宽度"]')
  await expect(pfwSwitch).toHaveCount(1)
  await expect(page.locator('.settings-content').getByText(/跟随全局默认/).first()).toBeVisible()

  // 开启纸宽开关 → 出现本书纸宽子项（原生 checkbox 视觉隐藏，点击可见的 switch-slider 经 label 触发）
  const slider = () => page.locator('label.switch', { has: pfwSwitch }).locator('.switch-slider')
  await slider().click()
  const bookW = page.locator('input[aria-label="本书纸宽"]')
  await expect(bookW).toBeVisible()
  const v = await bookW.inputValue()
  expect(Number(v)).toBeGreaterThan(0)

  // 关闭开关 → 子项消失，回到「跟随全局默认」（书级覆盖已移除）
  await slider().click()
  await expect(bookW).toBeHidden()
  await expect(page.locator('.settings-content').getByText(/跟随全局默认/).first()).toBeVisible()
})