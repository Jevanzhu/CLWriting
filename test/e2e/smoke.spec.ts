/**
 * e2e smoke（#13.1）：关键路径真渲染 + 交互。
 *
 * - 书架渲染（长/短篇双轨）
 * - 单书总览渲染（状态机卡）
 * - 建书段1 → 段2（AI 填设定向导，mock driver）
 * - 工作台 mock 生成细纲（spawnRole 假流 → 落盘 → 日志）
 *
 * globalSetup 已起 server（mock driver + fixture）。访问 baseURL 跑 SPA。
 */
import { test, expect } from '@playwright/test'

test('书架渲染含长/短篇双轨', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('长篇测试书')).toBeVisible()
  await expect(page.getByText('短篇测试集')).toBeVisible()
})

test('单书总览渲染（身份 + 进度 + 状态机）', async ({ page }) => {
  await page.goto('/')
  await page.getByText('长篇测试书').first().click()
  await expect(page.getByText('进度')).toBeVisible()
  await expect(page.getByText('写作位置')).toBeVisible()
})

test('建书段1 → 段2（AI 填设定向导）', async ({ page }) => {
  await page.goto('/books/new')
  await page.getByPlaceholder('如：我的世界').fill('e2e新书')
  await page.getByRole('button', { name: '创建' }).click()
  // 段2 标题出现 = 建书成功进 AI 填设定向导
  await expect(page.getByText('段 2')).toBeVisible()
})

test('工作台 mock 生成细纲（spawnRole 假流 → 落盘）', async ({ page }) => {
  await page.goto('/books/长篇测试书/workbench')
  // 点「细纲」→ POST /outline（mock driver spawnRole 假产出）→ 落盘 → 日志「细纲已生成」
  await page.getByRole('button', { name: /细纲/ }).click()
  await expect(page.getByText('细纲已生成').first()).toBeVisible({ timeout: 15_000 })
})
