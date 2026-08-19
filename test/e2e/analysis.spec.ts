/**
 * 分析 e2e（重写）：AnalysisPanel 重组后——章节标签 AI 分析 + 全书速览只读。
 *
 * AnalysisPanel 现在在信息 tab 的「AI 分析」折叠区（CollapseSection 默认展开）：
 * - 章节标签卡：点「分析标签」→ mock driver autotag 返固定标签 → 写入 fm → 标签渲染更新
 * - 全书速览卡：只读聚合 overview（体验分/文风/钩子），fixture 无信封 → 空态 —
 *
 * mock driver analyst role 返 tags: { 钩子类型:悬念钩, 钩子强弱:强, 情绪定位:转折, 场景:对话 }。
 * fixture 0001 fm 初始: 钩子类型:悬念钩, 钩子强弱:中, 情绪定位:铺垫, 场景:对话。
 * （旧版 4 个独立分析 card 已移到 Overview/rhythm 视图，此处只测右栏 AnalysisPanel。）
 */
import { test, expect } from '@playwright/test'

test('分析：选章 → AI 标签分析 → 标签更新 + 全书速览空态', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText('初入宗门').first().click()
  // kk 观察：CI 慢速 runner 冷启挂载可超默认 10s，编辑器挂载断言统一放宽（见 check.spec 注）
  await expect(page.locator('.cm-content')).toBeVisible({ timeout: 20_000 })

  // 切信息 tab（AnalysisPanel 在「AI 分析」折叠区，CollapseSection 默认展开）
  await page.locator('.right-tabs .right-tab').first().click()

  // 章节标签卡渲染：从 fm 读初始值（情绪定位 = 铺垫）
  const emotionCell = page.locator('.analysis-panel .ap-tag-cell', { hasText: '情绪定位' })
  await expect(emotionCell).toContainText('铺垫')

  // 点「分析标签」→ mock autotag → fm 更新（.ap-run 有两个：分析标签 + AI 推断，用文本精确定位）
  await page.locator('.analysis-panel .ap-run', { hasText: '分析标签' }).click()

  // 情绪定位 铺垫 → 转折（mock 返回值）
  await expect(emotionCell).toContainText('转折', { timeout: 15_000 })

  // 全书速览：fixture 无分析信封 → 体验分空态 —
  await expect(page.locator('.analysis-panel .ap-ov-empty').first()).toBeVisible()
})
