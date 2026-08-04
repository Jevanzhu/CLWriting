/**
 * 树红点冒泡 e2e（T9b）：审阅 verdict 驳回 → 章节行 + 写作组行亮红点（冒泡）；
 * 再点通过 → 该章红点灭。走前端渲染管线（tree store issuePaths 冒泡 + ChapterTreeItem 行尾红点）。
 *
 * 机检 red 聚合由 test/studio/tree-issues-api.test.ts 覆盖；本 spec 聚焦 UI 渲染 + 动态更新。
 * 选「玉佩之秘」（0002）为操作对象——悬念证据对齐后机检 clean，且无其他 spec 操作它
 * （ai-review/check/analysis 均用 0001），避免共享 workDir 的测试污染。
 */
import { test, expect } from '@playwright/test'

test('树红点：verdict 驳回 → 冒泡亮；通过 → 灭', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  // 选 0002「玉佩之秘」并打开
  await page.getByText('玉佩之秘').first().click()
  await expect(page.locator('.cm-content')).toBeVisible()

  // 定位 0002 树行 + 写作组行（冒泡目标）
  const row0002 = page.locator('.tree-item', { hasText: '玉佩之秘' }).first()
  const writeGroup = page.locator('.tree-item', { hasText: '写作' }).first()
  // 初始：0002 机检 clean、无 verdict → 行尾无红点
  await expect(row0002.locator('.issue-dot')).toHaveCount(0)

  // 审阅 tab（FileSearch，第2个 .right-tab）→ 点驳回
  await page.locator('.right-tabs .right-tab').nth(1).click()
  await expect(page.locator('.review-panel .rev-verdict-badge')).toHaveText('待审')
  await page.locator('.review-panel .rev-verdict-btn.reject').click()
  await expect(page.locator('.review-panel .rev-verdict-badge')).toHaveText('驳回')

  // 0002 行 + 写作组行（冒泡）亮红点
  await expect(row0002.locator('.issue-dot')).toBeVisible({ timeout: 10_000 })
  await expect(writeGroup.locator('.issue-dot')).toBeVisible()

  // 点通过 → 0002 红点灭（0001 若有 red 则写作组行不灭，但 0002 行必灭）
  await page.locator('.review-panel .rev-verdict-btn').first().click()
  await expect(page.locator('.review-panel .rev-verdict-badge')).toHaveText('通过')
  await expect(row0002.locator('.issue-dot')).toHaveCount(0, { timeout: 10_000 })
})
