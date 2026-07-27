/**
 * T1.5 全书搜索（M11 E1）：搜索入口 → 输入埋词 → 命中列表 → 点击跳转开 tab。
 *
 * fixture 埋词：长篇 0001/0002 含「玉佩」（正文）+ 角色 林远.md 关系 + 伏笔。
 * 命中 .result，点击 open(path) → doc.open + openTab → cm 渲染。
 */
import { test, expect } from '@playwright/test'

test('全书搜索 → 命中 → 跳转开 tab', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  // 切搜索面板
  await page.locator('.left-tab[data-tip="搜索"]').click()
  // 输入埋词 + 回车
  await page.getByPlaceholder('全书搜索…').fill('玉佩')
  await page.keyboard.press('Enter')
  // 命中列表出现
  await expect(page.locator('.result').first()).toBeVisible({ timeout: 5_000 })
  // 点首个命中 → 开 tab + cm 渲染
  await page.locator('.result').first().click()
  await expect(page.locator('.cm-content')).toBeVisible()
})
