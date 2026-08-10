/**
 * 版本恢复 e2e（第八轮方案 ★第2项，P1-T4）：
 * 选章 → 改内容 → ⌘S 保存（产生新版本）→ 右栏信息 tab「本章历史」→ 恢复旧版本
 * → 编辑区内容回退。
 *
 * 用 fixture 0002「玉佩之秘」（tree-ops 把 0001 移进卷 + 软删还原，不在正文根稳定位置；
 * 0002 未被移动/重命名，跨 spec 稳定）。
 * 保存/快照/恢复全走文件系统（.版本/），无 mock driver 依赖。
 */
import { test, expect } from '@playwright/test'

test('版本恢复：改稿保存 → 历史面板 → 恢复旧版 → 内容回退', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await expect(page.locator('.ws-shell')).toBeVisible()

  // 打开闪回：确保回到章节树面板 + 树就绪（防上题切走）
  await page.locator('.rbtn[data-tip*="章节树"]').click()
  await expect(page.locator('.tree-item').first()).toBeVisible()

  // 选章 + 记原内容（用 0002 玉佩之秘）
  await expect(page.getByText('玉佩之秘').first()).toBeVisible()
  await page.getByText('玉佩之秘').first().click()
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible()
  const original = (await cm.textContent()) ?? ''
  expect(original.length).toBeGreaterThan(0)

  // 追加内容 + ⌘S 保存 → 编辑区出现新句
  await cm.click()
  await page.keyboard.type('e2e版本恢复测试字串')
  await page.keyboard.press('Meta+s')
  await expect(page.locator('.save-group .save-btn')).toContainText('已保存', { timeout: 5_000 })
  await expect(cm).toContainText('e2e版本恢复测试字串')

  // 历史面板（右栏信息 tab 的「本章历史」折叠区）
  const history = page.locator('.history-panel')
  await expect(history).toBeVisible()
  // 至少有一条历史版本（保存产生；.row 含首行「当前」，恢复按钮在版本行）
  const rows = history.locator('.row')
  await expect(rows.first()).toBeVisible()
  // 恢复按钮 hover 才显形——hover 第一条版本行（跳过 .current 行）
  const firstVersionRow = history.locator('.row:not(.current)').first()
  await firstVersionRow.hover()
  const restoreBtn = firstVersionRow.locator('.restore-btn')
  await expect(restoreBtn).toBeVisible()
  await restoreBtn.click()

  // 确认框 → 恢复
  await page.locator('.cp-modal').getByRole('button', { name: '恢复' }).click()
  // toast 成功
  await expect(page.getByText(/已恢复到/)).toBeVisible({ timeout: 10_000 })

  // 编辑区内容回退：新句消失
  await expect(cm).not.toContainText('e2e版本恢复测试字串', { timeout: 10_000 })
})