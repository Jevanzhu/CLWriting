/**
 * Studio 真宿主 smoke：浏览器真实渲染 + 后端 ccDriver + 本机 claude CLI。
 *
 * 只放在 `test:e2e:true-host`，不进入默认 CI。它验证 GUI 可以通过
 * outline 端点走真宿主生成细纲并落盘，作为 mock e2e 之外的人工验收入口。
 */
import { test, expect } from '@playwright/test'

test('Studio 通过真宿主生成长篇细纲并落盘', async ({ page }) => {
  await page.goto('/books/长篇测试书/workbench')
  await expect(page.getByText('八阶段全接')).toBeVisible()

  await page.getByRole('button', { name: /细纲/ }).click()

  await expect(page.getByText('细纲已生成').first()).toBeVisible({ timeout: 300_000 })
  await expect(page.getByText(/^错误:/)).toHaveCount(0)
})
