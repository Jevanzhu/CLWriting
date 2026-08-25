/**
 * T1.6 专注模式（M11 E1）：入口切换 → 沉浸隐藏 → 退出还原。
 *
 * 完全沉浸批（2026-08-23）：focusMode = 全部 UI 隐藏（Ribbon/TabBar/状态栏/侧栏）+ 全屏
 * + 打字机（打字机为 CM6 输入时滚动行为，无 DOM class，单测锁 typewriter.test.ts）。
 * 退出走 Esc（完全沉浸下 TabBar 已隐藏，原「再点按钮」路径不存在；e2e 跑浏览器形态，
 * 无桌面桥 → 全屏走 HTML5 API，click 前置有手势）。
 */
import { test, expect } from '@playwright/test'

test('专注模式：沉浸隐藏 + Esc 退出还原', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  // 打开一章（纸张宽度断言需要 .doc-page 在场；空态编辑器无纸张）
  await page.getByText('初入宗门').first().click()
  await expect(page.locator('.doc-page')).toBeVisible()
  // 初始侧栏展开
  await expect(page.locator('.ws-left')).not.toHaveClass(/collapsed/)
  // 点 Focus（ViewHeader 唯一 action-btn）
  const focusBtn = page.locator('[data-tip*="专注"]')
  await focusBtn.click()
  await expect(page.locator('.ws-left')).toHaveClass(/collapsed/)
  await expect(page.locator('.ws-right')).toHaveClass(/collapsed/)
  // 完全沉浸：外壳 ws-focus class + TabBar 隐藏 + 右下角退出按钮出现
  await expect(page.locator('.ws-shell')).toHaveClass(/ws-focus/)
  await expect(page.locator('.tabbar')).toBeHidden()
  await expect(page.locator('.ws-focus-exit')).toBeVisible()
  // 排版浮动条（2026-08-24 批）：右缘竖状常驻 + 字号/行距/纸宽三滑杆（e2e 浏览器形态
  // 无桌面桥 → 字体区隐藏）；纸张宽度回归设置值（--page-width 1020px，不再 +160 放大）
  await expect(page.locator('.focus-format-bar')).toBeVisible()
  await expect(page.locator('.focus-format-bar .ffb-range')).toHaveCount(3)
  await expect(page.locator('.focus-format-bar .ffb-select')).toHaveCount(0)
  await expect(page.locator('.doc-page')).toHaveCSS('max-width', '1020px')
  // Esc 退出 → 还原
  await page.keyboard.press('Escape')
  await expect(page.locator('.ws-left')).not.toHaveClass(/collapsed/)
  await expect(page.locator('.ws-right')).not.toHaveClass(/collapsed/)
  await expect(page.locator('.ws-shell')).not.toHaveClass(/ws-focus/)
  await expect(page.locator('.tabbar')).toBeVisible()
  await expect(page.locator('.focus-format-bar')).toBeHidden()
  await expect(focusBtn).not.toHaveClass(/active/)
})
