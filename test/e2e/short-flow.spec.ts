/**
 * 短篇 e2e 冒烟（第八轮方案 ★第3项，P2-T4）：
 * 书架见短篇书卡 → 打开（无 wiring，目录正确）→ 选篇 → 编辑器渲染 → 关系图可访问。
 *
 * fixture 短篇测试集：写作/正文/001-雨夜门铃.md（无 布线/ 目录）。
 */
import { test, expect } from '@playwright/test'

test('短篇冒烟：开书 → 选篇 → 编辑器 → 关系图', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '书架' })).toBeVisible()
  // 短篇书卡可见
  await expect(page.locator('.book-title', { hasText: '短篇测试集' })).toBeVisible()

  // 打开短篇书 → 工作区
  await page.locator('.book-title', { hasText: '短篇测试集' }).click()
  await expect(page).toHaveURL(/\/book\//)
  await expect(page.locator('.ws-shell')).toBeVisible()

  // 目录结构正确：树含短篇正文（0001 雨夜门铃），且「写作」下无「布线」卷标
  await expect(page.locator('.tree-list')).toContainText('雨夜门铃')
  await expect(page.locator('.tree-list')).not.toContainText('布线')

  // 选篇 → 编辑器渲染正文
  await page.getByText('雨夜门铃').first().click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('门外没有脚印')

  // 关系图视图可访问（短篇放开后不应拦截）
  await page.locator('.rbtn[data-tip="角色关系图"]').click()
  await expect(page.locator('.rel-scroll')).toBeVisible()
})