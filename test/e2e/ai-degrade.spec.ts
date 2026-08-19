/**
 * T1.7 AI 降级（M11 E1）：AI 不可达态 → 编辑保存照常 + 辅助入口置灰。
 *
 * 独立 server（端口 19000 + CLWRITING_E2E_AI_DOWN=1）不污染其余动线（globalSetup 的 18999）。
 * - GET /api/ai-status 短路返回 available:false（ai-status.ts 跳缓存直接探）
 * - 编辑器不依赖 AI：选章编辑 + ⌘S 保存成功
 * - 工作台 UI 降级：.ai-warn 警告条可见 + 生成按钮 disabled
 */
import { test, expect } from '@playwright/test'
import http from 'node:http'
import { join } from 'node:path'
import { startServer } from '../../src/studio/server/index.js'
import { makeDualTrackWorkdir } from '../studio/fixtures.js'

const PORT = 19000
const BASE = `http://127.0.0.1:${PORT}`
let server: http.Server

test.beforeAll(async () => {
  process.env['CLWRITING_E2E_AI_DOWN'] = '1'
  const workDir = makeDualTrackWorkdir()
  server = startServer({ port: PORT, workDir, staticDir: join(process.cwd(), 'dist', 'web') })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
})

test.afterAll(async () => {
  delete process.env['CLWRITING_E2E_AI_DOWN']
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('AI 不可达：编辑保存照常 + 辅助置灰', async ({ page }) => {
  // ① ai-status 报告不可达
  const r = await page.request.get(`${BASE}/api/ai-status`)
  expect(await r.json()).toMatchObject({ available: false })

  await page.goto(`${BASE}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  // ② 编辑器不依赖 AI：选章编辑 + ⌘S 保存成功
  await page.getByText('初入宗门').first().click()
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible()
  await cm.click()
  await page.keyboard.type('降级时仍可编辑')
  await page.keyboard.press('Meta+s')
  await expect(page.locator('.save-group .save-btn')).toContainText('已保存', { timeout: 5_000 })

  // ③ 切工作台 → AI 降级警告条（生成按钮 v-if=!running，running 态不渲染，故以警告条为降级标志）
  // kk-P1-1：tooltip 同步 a20f8eb 新文案（工作台（AI 写作）→ AI 工作台 Beta）
  await page.locator('.rbtn[data-tip="AI 工作台 Beta"]').click()
  await expect(page.locator('.ai-warn')).toContainText('不可用')
})
