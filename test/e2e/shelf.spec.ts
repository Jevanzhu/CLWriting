/**
 * T1.1 书架 → 开书（M11 E1）。
 *
 * 兼 T1.0 冒烟：验证 globalSetup（mock driver + 双轨 fixture + dist/web 静态托管）
 * 起 server 正常 + 前端首屏渲染。两条断言用书名文案（Shelf.vue 书卡 .book-title 显 title）。
 *
 * 依赖 fixture：长篇测试书 / 短篇测试集（test/studio/fixtures.ts）。
 */
import { test, expect } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'

test('书架渲染含长/短篇双轨书卡', async ({ page }) => {
  attachPageErrorBaseline(page, 'shelf')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '书架' })).toBeVisible()
  // 书卡 .book-title 显 title（exact 避免命中 .book-name 的 kind+name 组合串）
  await expect(page.locator('.book-title', { hasText: '长篇测试书' })).toBeVisible()
  await expect(page.locator('.book-title', { hasText: '短篇测试集' })).toBeVisible()
})

test('点书卡进书 → 工作区 shell 渲染', async ({ page }) => {
  attachPageErrorBaseline(page, 'shelf')
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  // openBook → router.push('/book/:name')；URL 含 /book/ 即进书
  await expect(page).toHaveURL(/\/book\//)
  // WorkspaceShell 容器渲染（常驻，不依赖具体 view）
  await expect(page.locator('.ws-shell')).toBeVisible()
})
