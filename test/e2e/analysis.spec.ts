/**
 * 分析 e2e（M12 块4 B4.5）：选章 → 分析 tab → 重新分析 → 体验分展示
 * → 改正文 + ⌘S → reload → 存量仍在 + 过期标注。
 *
 * mock driver analyst role 按 [kind:score] 标记返固定 score JSON（payload.score=8）。
 * 验证「生成与展示解耦」：AI 产信封落盘，编辑器读盘展示；正文变更 → 存量标过期（不隐藏）。
 */
import { test, expect } from '@playwright/test'

test('分析：选章 → 重新分析 → 体验分 → 改正文 → 存量 + 过期标注', async ({ page }) => {
  await page.goto('/')
  await page.getByText('长篇测试书', { exact: true }).click()
  await page.getByText('初入宗门').first().click()
  await expect(page.locator('.cm-content')).toBeVisible()

  // 切右栏「分析」tab（第4个 .right-tab：信息/审阅/机检/分析）
  await page.locator('.right-tab').nth(3).click()

  // 暂无体验分 → 点「重新分析」
  await expect(page.locator('.analysis-panel .ap-empty')).toBeVisible()
  await page.locator('.analysis-panel .ap-run').click()

  // mock analyst 产 score → 体验分渲染（大数字 = 8）
  await expect(page.locator('.analysis-panel .ap-score-num')).toHaveText('8', { timeout: 15_000 })
  await expect(page.locator('.analysis-panel .ap-verdict')).toContainText('mock 体验')

  // 改正文 + ⌘S 落盘（正文 hash 变 → 信封将过期）
  const cm = page.locator('.cm-content')
  await cm.click()
  await page.keyboard.type('e2e 改动正文触发过期')
  await page.keyboard.press('Meta+s')
  await expect(page.locator('.save-state')).toContainText('已保存', { timeout: 5_000 })

  // reload → 存量信封仍在 + 过期标注（正文已变更）
  await page.reload()
  await page.getByText('长篇测试书', { exact: true }).click()
  await page.getByText('初入宗门').first().click()
  await page.locator('.right-tab').nth(3).click()
  await expect(page.locator('.analysis-panel .ap-score-num')).toHaveText('8')
  await expect(page.locator('.analysis-panel .ap-stale')).toBeVisible()
})
