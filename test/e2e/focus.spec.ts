/**
 * T1.6 专注模式（M11 E1）：入口切换 → 侧栏隐藏 → 退出还原。
 *
 * focusMode = 隐藏左右侧栏 + 打字机（打字机为 CM6 输入时滚动行为，无 DOM class，靠手测/单测）。
 * 布局断言走 .ws-side.collapsed（WorkspaceShell width:0 收起态）+ ViewHeader action-btn active。
 */
import { test, expect } from '@playwright/test'

test('专注模式：侧栏隐藏 + 退出还原', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  // 初始侧栏展开
  await expect(page.locator('.ws-left')).not.toHaveClass(/collapsed/)
  // 点 Focus（ViewHeader 唯一 action-btn）
  const focusBtn = page.locator('.view-header .action-btn')
  await focusBtn.click()
  await expect(page.locator('.ws-left')).toHaveClass(/collapsed/)
  await expect(page.locator('.ws-right')).toHaveClass(/collapsed/)
  await expect(focusBtn).toHaveClass(/active/)
  // 退出 → 还原
  await focusBtn.click()
  await expect(page.locator('.ws-left')).not.toHaveClass(/collapsed/)
  await expect(page.locator('.ws-right')).not.toHaveClass(/collapsed/)
})
