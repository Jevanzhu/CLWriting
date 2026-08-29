/**
 * 机检 e2e（M12 块3 B3.3）：选章 → 右栏「机检」tab → 点机检 → 出报告。
 *
 * 机检无 AI 依赖（本地 runAllChecks），mock driver 下天然「断网可用」——
 * 与块1 三审（置灰）形成降级对照（三审 e2e 在切片3）。
 */
import { test, expect } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'

test('机检：选章 → 机检 tab → 出报告（无 AI 依赖）', async ({ page }) => {
  attachPageErrorBaseline(page, 'check')
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText('初入宗门').first().click()
  // 编辑区渲染（章节已打开）。kk 观察：CI 慢速 runner 下冷启挂载可超默认 10s（首跑
  // 抖动实证），与 ai-review/analysis/conflict 同模式的编辑器挂载断言统一放宽到 20s
  await expect(page.locator('.cm-content')).toBeVisible({ timeout: 20_000 })

  // 切右栏「机检」tab（CheckSquare 图标，第3个 .right-tab：信息/审阅/机检/分析）
  await page.locator('.right-tabs .right-tab').nth(2).click()
  // CheckPanel 渲染 → 点「机检」按钮
  await page.locator('.check-run-btn').click()
  // 报告产出：未发现问题(.check-clean) 或 红/黄项分组(.check-group) 可见
  await expect(page.locator('.check-panel .check-clean, .check-panel .check-group').first()).toBeVisible({
    timeout: 15_000,
  })
  // 弱断言加强（P1-T5）：有分组时必须真的产出条目，否则只是「区域可见」形同虚设
  const groupCount = await page.locator('.check-group').count()
  if (groupCount > 0) {
    await expect(page.locator('.check-item').first()).toBeVisible()
  }
})
