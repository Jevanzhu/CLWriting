/**
 * D1（批 4）用量卡片 e2e：开书默认进工作台 → 「AI 用量」卡可见
 * （空书无记录 → 空态文案；有记录 → 表格 + 未配价引导，金额口径不在 e2e 断言面）。
 */
import { test, expect } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'

test('用量卡：工作台视图展示「AI 用量」卡（D1）', async ({ page }) => {
  attachPageErrorBaseline(page, 'usage-card')
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  // 开书默认进编辑器视图 → ribbon 切「工作台」
  await page.getByRole('button', { name: '工作台' }).click()
  // CI 慢速 runner 挂载放宽（与 check.spec 同口径）
  await expect(page.locator('.usage-card')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.usage-card .usage-title')).toContainText('AI 用量')
  // R73-70（F-3）：收紧原「empty+table>0」弱断言——loading 态的「统计加载中…」也挂
  // .usage-empty 类，旧口径会把未 settle 的加载中当空态放过（假绿）。上游 edit-save
  // 已恢复派生状态（字数日记 delta/树缓存），本卡可收紧为实质断言：
  // ①「统计加载中」必须退场（数据已 settle）；②两态仍都合法（取决于前序 AI spec
  // 是否留下事件，非本卡可控），但各自锚定实质内容而非仅 count>0。
  await expect(page.locator('.usage-card .usage-empty', { hasText: '统计加载中' })).toHaveCount(0)
  const empty = await page.locator('.usage-card .usage-empty').count()
  const table = await page.locator('.usage-card table').count()
  expect(empty + table).toBeGreaterThan(0)
  if (empty > 0) {
    // 空态：锚定真实空态文案（区分于加载中/渲染异常的空壳）
    await expect(page.locator('.usage-card .usage-empty')).toContainText('暂无 AI 调用记录')
  } else {
    // 表格态：至少一行任务数据（表头壳不算渲染成功）
    await expect(page.locator('.usage-card table tbody tr').first()).toBeVisible()
  }
})
