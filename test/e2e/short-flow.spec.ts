/**
 * 短篇 e2e 冒烟（第八轮方案 ★第3项，P2-T4）：
 * 书架见短篇书卡 → 打开（无 wiring，目录正确）→ 选篇 → 编辑器渲染 → 关系图可访问。
 *
 * fixture 短篇测试集：写作/正文/001-雨夜门铃.md（无 布线/ 目录）。
 *
 * P2-13（09-30 评审修复批）：只读冒烟（选篇开编辑器不改盘；未接 autosave 写入）→ 迁独立
 * server（端口偏移 8）+ 自有 workDir，脱离共享 workDir 的顺序契约；起停样板见
 * ./independent-server.ts。userDataPath: false 对齐 globalSetup 主 server 口径。
 */
import { test, expect } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'
import { startIndependentServer, type IndependentServer } from './independent-server.js'

let srv: IndependentServer

test.beforeAll(async () => {
  srv = await startIndependentServer({ tag: 'short-flow', offset: 8, userDataPath: false })
})

test.afterAll(async () => {
  await srv.close()
})

test('短篇冒烟：开书 → 选篇 → 编辑器 → 关系图', async ({ page }) => {
  attachPageErrorBaseline(page, 'short-flow')
  await page.goto(`${srv.base}/`)
  await expect(page.getByRole('heading', { name: '书架' })).toBeVisible()
  // 短篇书卡可见
  await expect(page.locator('.book-title', { hasText: '短篇测试集' })).toBeVisible()

  // 打开短篇书 → 工作区
  await page.locator('.book-title', { hasText: '短篇测试集' }).click()
  await expect(page).toHaveURL(/\/book\//)
  await expect(page.locator('.ws-shell')).toBeVisible()

  // 目录结构正确：树含短篇正文（0001 雨夜门铃），且「写作」下无「布线」卷标
  await expect(page.locator('.tree-list')).toContainText('雨夜门铃')
  await expect(page.locator('.tree-list')).not.toContainText('布线')

  // 选篇 → 编辑器渲染正文
  await page.getByText('雨夜门铃').first().click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('门外没有脚印')

  // 关系图视图可访问（短篇放开后不应拦截）；kk-P1-1：tooltip 同步 a20f8eb 新文案
  await page.locator('.rbtn[data-tip="角色关系图 Beta"]').click()
  await expect(page.locator('.rel-scroll')).toBeVisible()
})
