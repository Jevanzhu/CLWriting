/**
 * 供应商配置全流程（审查 §八⑨：e2e 补供应商配置 spec）。
 *
 * 独立 server（端口 19001 + CLWRITING_DRIVER=mock + 显式 userDataPath），不污染 globalSetup 的 18999。
 * 路径：设置 → AI 服务商 tab → 添加供应商 → 测试连接（mock 短路返回全能力）→ 设为当前 → ai-status 可达 → 工作台解灰。
 */
import { test, expect } from '@playwright/test'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../../src/studio/server/index.js'
import { makeDualTrackWorkdir } from '../studio/fixtures.js'

const PORT = 19001
const BASE = `http://127.0.0.1:${PORT}`
let server: http.Server
let workDir = ''
let userDataPath = ''
let prevDriver: string | undefined

test.beforeAll(async () => {
  prevDriver = process.env.CLWRITING_DRIVER
  process.env.CLWRITING_DRIVER = 'mock'
  workDir = makeDualTrackWorkdir()
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-e2e-provider-ud-'))
  server = startServer({ port: PORT, workDir, userDataPath, staticDir: join(process.cwd(), 'dist', 'web') })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
})

test.afterAll(async () => {
  if (prevDriver === undefined) delete process.env.CLWRITING_DRIVER
  else process.env.CLWRITING_DRIVER = prevDriver
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

test('添加→测试→双供应商切换→工作台解灰 全流程', async ({ page }) => {
  await page.goto(`${BASE}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  // 打开设置 → AI 服务商 tab（服务商面板在「AI 服务商」tab，非「AI 功能」tab）
  await page.locator('.rbtn[data-tip="设置（⌘,）"]').click()
  await page.locator('.settings-nav button', { hasText: 'AI 服务商' }).click()

  // 空态 → 添加第一个供应商（协议默认 OpenAI 兼容格式）
  await page.locator('.ai-service-panel .add-btn', { hasText: '添加' }).click()
  let inputs = page.locator('.ai-service-panel .form .text-input')
  await inputs.nth(0).fill('我的中转')
  await inputs.nth(1).fill('https://openai.local/v1')
  await inputs.nth(2).fill('sk-test-key-1234')
  await page.locator('.ai-service-panel .form .save-btn').click()

  let card = page.locator('.provider-card')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('我的中转')

  // 第一个自动成为当前（POST 首条语义）：dot.on + 无「启用」按钮
  await expect(card.locator('.dot.on')).toBeVisible()

  // 测试连接：mock 短路返回全能力 → caps 徽章出现
  await card.locator('.mini-btn[data-tip="测试连接"]').click()
  await expect(card.locator('.caps-badge')).toContainText('已连接', { timeout: 10_000 })

  // 添加第二个供应商
  await page.locator('.ai-service-panel .add-btn', { hasText: '添加' }).click()
  inputs = page.locator('.ai-service-panel .form .text-input')
  await inputs.nth(0).fill('备用中转')
  await inputs.nth(1).fill('https://backend.local/v1')
  await inputs.nth(2).fill('sk-test-key-9999')
  await page.locator('.ai-service-panel .form .save-btn').click()

  await expect(page.locator('.provider-card')).toHaveCount(2)
  card = page.locator('.provider-card', { hasText: '备用中转' })
  // 第二个不是 current → 有「设为当前启用」按钮；点击切换（P0-1：PUT /current 不被 /:id 遮蔽）
  await card.locator('.mini-btn[data-tip="测试连接"]').click()
  await expect(card.locator('.caps-badge')).toContainText('已连接', { timeout: 10_000 })
  await card.locator('.mini-btn[data-tip="设为当前启用"]').click()
  await expect(card.locator('.dot.on')).toBeVisible()

  // 后端 ai-status 即刻可达（P0-2 无缓存）
  const j = await (await page.request.get(`${BASE}/api/ai-status`)).json()
  expect(j).toMatchObject({ available: true })

  // 关设置 → 工作台「生成」按钮解灰（不再 disabled）
  await page.locator('.settings-modal .close-btn').click()
  await page.locator('.rbtn[data-tip="工作台（AI 写作）"]').click()
  await expect(page.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
})