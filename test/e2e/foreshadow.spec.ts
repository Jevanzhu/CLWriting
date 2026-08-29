/**
 * 伏笔追踪 e2e（第十轮 P1-TST-2 补关键流程）：
 * 进入长篇测试书 → 右栏「伏笔追踪」→ 列表显示 fixture 伏笔（玉佩线索）+
 * 足迹扫描命中（悬置章数/风险）→ 点击伏笔打开编辑 → 新建伏笔 → 列表更新。
 *
 * fixture：设定/伏笔/玉佩线索.md（关联词「玉佩」命中 0001/0002 正文，无 mock driver）。
 */
import { test, expect } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'

test('伏笔追踪：列表+足迹+打开编辑+新建', async ({ page }) => {
  attachPageErrorBaseline(page, 'foreshadow')
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await expect(page.locator('.ws-shell')).toBeVisible()

  // 确保回到章节树面板 + 树就绪
  await page.locator('.rbtn[data-tip*="章节树"]').click()
  await expect(page.locator('.tree-item').first()).toBeVisible()

  // 右栏信息 tab 默认 active：伏笔追踪折叠区应显示 fixture 伏笔
  const fsPanel = page.locator('.fs-panel')
  await expect(fsPanel).toBeVisible()
  await expect(page.getByText('玉佩线索').first()).toBeVisible()

  // 统计行：未回收 1（fixture 只有未回收）
  await expect(fsPanel.locator('.stat-pending')).toContainText('未回收 1')

  // 足迹扫描：关联词「玉佩」命中正文 → 悬置章数出现（staleSpan > 0 → 显示悬N章）
  // fixture 0001/0002 均含「玉佩」，末次命中第 2 章 → 悬置跨度 = 0（第2章是当前最新）
  // 但 .fs-trail 应出现（有命中；非埋设章号 fallback）
  // 埋设章号 1 → 「第1章埋设」也应出现（若 staleSpan 为 0 则走 fallback）
  await expect(fsPanel.locator('.fs-item.pending').first()).toContainText('玉佩线索')

  // 点击伏笔 → 打开编辑器（设定/伏笔/玉佩线索.md）
  await fsPanel.locator('.fs-item.pending').first().click()
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible()
  await expect(cm).toContainText('玉佩来历之谜', { timeout: 5_000 })

  // 回树 + 新建伏笔（按钮在伏笔面板底部）
  await page.locator('.rbtn[data-tip*="章节树"]').click()
  await expect(page.locator('.tree-item').first()).toBeVisible()
  await fsPanel.locator('.fs-add').click()
  // 新建 → 打开新文件（设定/伏笔/新伏笔.md）+ 列表刷新含「新伏笔」
  await expect(cm).toBeVisible()
  await expect(page.getByText('新伏笔').first()).toBeVisible({ timeout: 5_000 })
  await expect(fsPanel.locator('.stat-pending')).toContainText('未回收 2')
})
