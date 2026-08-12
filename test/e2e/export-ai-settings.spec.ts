/**
 * P2-TST-7：缺功能 e2e 补齐——导出对话框流程 + AI 设置面板。
 *
 * 导出：ribbon「导出定稿」→ 弹窗（格式 both/分章/合并 + 平台）→ 选分章 → 导出
 *   → toast「导出完成」→ 弹窗关。fixture 长篇有 3 章定稿可导出。
 * AI 设置：ribbon「设置」→ AI tab → 对话助手 switch 切换 → 关弹窗。
 * 文风/节奏预测已由 learn.spec / overview-short.spec 覆盖。
 */
import { test, expect } from '@playwright/test'

test('导出：打开弹窗 → 选分章格式 → 导出 → toast + 弹窗关闭', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await expect(page.locator('.ws-shell')).toBeVisible()

  // ribbon 导出定稿 → 弹窗（data-testid 模式，P2-TST-4）
  await page.locator('.rbtn[data-tip="导出定稿"]').click()
  const dialog = page.locator('[data-testid="export-dialog"]')
  await expect(dialog).toBeVisible()

  // 默认格式 both 选中（label「全量」+ hint「合并 + 分章」）
  await expect(dialog.locator('[data-testid="export-format-both"].on')).toContainText('全量')

  // 选「分章」格式
  await dialog.locator('[data-testid="export-format-split"]').click()
  await expect(dialog.locator('[data-testid="export-format-split"].on')).toContainText('分章')

  // 平台 seg 默认 generic（通用）
  await expect(dialog.locator('[data-testid="export-platform-generic"].on')).toContainText('通用')

  // 点导出 → toast「导出完成」+ 弹窗关闭
  await dialog.locator('[data-testid="export-run"]').click()
  await expect(page.getByText('导出完成')).toBeVisible({ timeout: 15_000 })
  await expect(dialog).toBeHidden()
})

test('AI 设置：设置弹窗 → AI tab → 对话助手开关切换', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await expect(page.locator('.ws-shell')).toBeVisible()

  // ribbon 设置 → 弹窗
  await page.locator('.rbtn[data-tip*="设置"]').click()
  const settings = page.locator('.settings-modal')
  await expect(settings).toBeVisible()

  // 切 AI tab（左侧导航含「AI」）
  await settings.locator('.settings-nav button', { hasText: 'AI' }).click()
  await expect(settings.locator('.settings-tab')).toBeVisible()

  // 对话助手 switch 初始未勾选（prefs.chatEnabled 默认 false）
  const chatSwitch = settings.locator('input[aria-label="对话助手"]')
  await expect(chatSwitch).not.toBeChecked()

  // 切换开关 → 勾选（input opacity:0/0宽高，点外层 .switch label 触发）
  await settings.locator('.setting-item', { hasText: '对话助手' }).locator('.switch').click()
  await expect(chatSwitch).toBeChecked()

  // 关闭弹窗
  await settings.locator('.close-btn').click()
  await expect(settings).toBeHidden()
})
