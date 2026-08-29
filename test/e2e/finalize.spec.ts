/**
 * 定稿 e2e（第八轮方案 ★第1项，P1-T4）：
 * 选章（fixture 0003，预设 revision 态）→ 顶部定稿按钮 → toast「已定稿」→
 * 树节点状态 dot 变 green（final）→ 内容不变。
 *
 * fixture 0003「定稿观察」manifest 预设 finalizedRevision 旧指纹 → 初始即 revision 态
 * （D4：仅 revision 态可定稿）。不污染被多 spec 复用的 0001/0002。
 */
import { test, expect } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'

test('定稿：选 revision 章 → 定稿 → toast + 树节点 final', async ({ page }) => {
  attachPageErrorBaseline(page, 'finalize')
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await expect(page.locator('.ws-shell')).toBeVisible()

  // 选章（0003 定稿观察，revision 态）
  await expect(page.getByText('定稿观察').first()).toBeVisible()
  await page.getByText('定稿观察').first().click()
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible()

  // 定稿按钮：revision 态正文可定稿
  const finalizeBtn = page.locator('.finalize-btn')
  await expect(finalizeBtn).toBeVisible()
  await expect(finalizeBtn).toContainText('定稿')

  // 树节点初始 revision（dot-red，非 final）
  const treeRow = page.locator('.tree-item').filter({ hasText: '定稿观察' }).first()
  await expect(treeRow.locator('.dot.dot-red')).toBeVisible()

  // 点定稿 → toast「已定稿」
  await finalizeBtn.click()
  await expect(page.getByText('已定稿')).toBeVisible({ timeout: 10_000 })

  // 树节点状态回 final（dot → green）——finalize 后前端重拉树
  await expect(treeRow.locator('.dot.dot-green')).toBeVisible({ timeout: 10_000 })

  // 定稿后按钮消失（isFinalizable 变 false），且内容不变
  await expect(finalizeBtn).toBeHidden()
  const bodyText = await cm.textContent()
  expect(bodyText).toContain('壁画')
})