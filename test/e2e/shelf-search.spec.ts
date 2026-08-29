/**
 * P2-PROD-6：书架搜索/排序 e2e。
 *
 * 依赖 fixture：长篇测试书 / 短篇测试集（test/studio/fixtures.ts）。
 * 搜索按书名模糊过滤；排序切换后书卡顺序变化。
 */
import { test, expect } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'

test.beforeEach(async ({ page }) => {
  // R74-24（批E）：本 spec 4 用例共享 beforeEach 开页，基线在此一次挂全（先于 goto）
  attachPageErrorBaseline(page, 'shelf-search')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '书架' })).toBeVisible()
})

test('搜索框按书名过滤（长短篇都过滤）', async ({ page }) => {
  await page.getByPlaceholder('搜索书名…').fill('长篇')
  // 长篇命中，短篇被过滤
  await expect(page.locator('.book-title', { hasText: '长篇测试书' })).toBeVisible()
  await expect(page.locator('.book-title', { hasText: '短篇测试集' })).toBeVisible({ visible: false })
})

test('搜索无结果 → 分组区清空（无空组残留）', async ({ page }) => {
  await page.getByPlaceholder('搜索书名…').fill('不存在的书')
  await expect(page.locator('.book-title')).toHaveCount(0)
  // 无命中时不显示空分组标题
  await expect(page.locator('.section-title')).toHaveCount(0)
})

test('排序：按书名 → 拼音序（长篇测试书在前）', async ({ page }) => {
  await page.getByLabel('排序方式').selectOption('name')
  // zh-CN localeCompare：长(cháng) < 短(duǎn)，首卡应是长篇测试书
  const firstTitle = await page.locator('.book-title').first().textContent()
  expect(firstTitle).toContain('长篇测试书')
  const lastTitle = await page.locator('.book-title').last().textContent()
  expect(lastTitle).toContain('短篇测试集')
})

test('排序切换后清空搜索词也保留顺序', async ({ page }) => {
  await page.getByLabel('排序方式').selectOption('created')
  await page.getByPlaceholder('搜索书名…').fill('长篇')
  await expect(page.locator('.book-title', { hasText: '短篇测试集' })).toBeVisible({ visible: false })
  await page.getByPlaceholder('搜索书名…').fill('')
  // 清空后回到全书列表
  await expect(page.locator('.book-title', { hasText: '长篇测试书' })).toBeVisible()
  await expect(page.locator('.book-title', { hasText: '短篇测试集' })).toBeVisible()
})
