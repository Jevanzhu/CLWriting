/**
 * 供应商配置全流程（审查 §八⑨：e2e 补供应商配置 spec）。
 *
 * 独立 server（端口 19001 + CLWRITING_DRIVER=mock + 显式 userDataPath），不污染 globalSetup 的 18999。
 * 路径：设置 → AI 提供方 tab → 添加提供方 → 测试连接（mock 短路返回全能力）→ 设为当前 → ai-status 可达 → 工作台解灰。
 *
 * 面板内部分页：「AI 提供方」（聊天模型 + 任务档位）/「RAG 提供方」两个 tab——
 * 同一时刻只挂载其一，但聊天侧选择器仍按直接子级（>）收窄以防回归。
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

  // 打开设置 → 服务提供方 tab（提供方面板在「AI 提供方」tab，非「AI 功能」tab）
  await page.locator('.rbtn[data-tip="设置（⌘,）"]').click()
  await page.locator('.settings-nav button', { hasText: '服务提供方' }).click()

  // 空态 → 添加第一个供应商（协议默认 OpenAI 兼容格式）
  await page.locator('.ai-service-panel > .group-title .add-btn', { hasText: '添加' }).click()
  let inputs = page.locator('.ai-service-panel > .form .text-input')
  await inputs.nth(0).fill('我的中转')
  await inputs.nth(1).fill('https://openai.local/v1')
  await inputs.nth(2).fill('sk-test-key-1234')
  await page.locator('.ai-service-panel > .form .save-btn').click()

  let card = page.locator('.ai-service-panel .provider-row')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('我的中转')

  // 第一个自动成为当前（POST 首条语义）：dot.on + 无「启用」按钮
  await expect(card.locator('.dot.on')).toBeVisible()

  // 测试连接：mock 短路返回全能力 → caps 徽章出现
  await card.locator('.mini-btn[data-tip="测试连接"]').click()
  await expect(card.locator('.caps-badge')).toContainText('已连接', { timeout: 10_000 })

  // 添加第二个供应商
  await page.locator('.ai-service-panel > .group-title .add-btn', { hasText: '添加' }).click()
  inputs = page.locator('.ai-service-panel > .form .text-input')
  await inputs.nth(0).fill('备用中转')
  await inputs.nth(1).fill('https://backend.local/v1')
  await inputs.nth(2).fill('sk-test-key-9999')
  await page.locator('.ai-service-panel > .form .save-btn').click()

  await expect(page.locator('.ai-service-panel .provider-row')).toHaveCount(2)
  card = page.locator('.ai-service-panel .provider-row', { hasText: '备用中转' })
  // 第二个不是 current → 有「设为当前启用」按钮；点击切换（P0-1：PUT /current 不被 /:id 遮蔽）
  await card.locator('.mini-btn[data-tip="测试连接"]').click()
  await expect(card.locator('.caps-badge')).toContainText('已连接', { timeout: 10_000 })
  await card.locator('.mini-btn[data-tip="设为当前启用"]').click()
  await expect(card.locator('.dot.on')).toBeVisible()

  // 后端 ai-status 即刻可达（P0-2 无缓存）
  const j = await (await page.request.get(`${BASE}/api/ai-status`)).json()
  expect(j).toMatchObject({ available: true })

  // —— RAG 提供方：切到面板内「RAG 提供方」分页管理 ——
  await page.locator('.panel-tab', { hasText: 'RAG 提供方' }).click()
  await page.locator('.rag-provider-section .add-btn', { hasText: '添加' }).click()
  const ragInputs = page.locator('.rag-provider-section .form .text-input')
  await ragInputs.nth(0).fill('嵌入验证')
  await ragInputs.nth(1).fill('https://embed.local/v1/embeddings')
  await ragInputs.nth(2).fill('text-embedding-3-small')
  await ragInputs.nth(3).fill('sk-embed-key-1')
  await page.locator('.rag-provider-section .form .save-btn').click()

  const ragCard = page.locator('.rag-provider-section .provider-row')
  await expect(ragCard).toHaveCount(1)
  await expect(ragCard).toContainText('嵌入验证')
  await expect(ragCard).toContainText('text-embedding-3-small')
  // KEY 已完全隐藏：卡片既不回明文也不回脱敏残留（安全不变式）
  await expect(ragCard).not.toContainText('sk-embed-key-1')
  await expect(ragCard).not.toContainText('sk-e...')

  // —— 「AI 功能」页：启用检索 + 选用刚建的 RAG 提供方 → book.yaml 落 rag.provider ——
  await page.locator('.settings-nav button', { hasText: 'AI 功能' }).click()
  // input opacity:0/0宽高，点外层 .switch label 触发（同 export-ai-settings.spec.ts）
  await page.locator('.setting-item', { hasText: '启用检索' }).locator('.switch').click()
  const ragList = await (await page.request.get(`${BASE}/api/rag-providers`)).json()
  expect(ragList.ragProviders).toHaveLength(1)
  await page.locator('.rag-prov-select').selectOption(ragList.ragProviders[0].id)

  // GET 信封是 {config}；saveConfig 的 PUT 串行但在途，用 poll 等落盘
  await expect
    .poll(async () => {
      const c = await (await page.request.get(`${BASE}/api/books/长篇测试书/config`)).json()
      return c.config?.rag ?? null
    })
    .toMatchObject({ enabled: true, provider: ragList.ragProviders[0].id })

  // 关设置 → 工作台「生成」按钮解灰（不再 disabled）
  await page.locator('.settings-modal .close-btn').click()
  await page.locator('.rbtn[data-tip="工作台（AI 写作）"]').click()
  await expect(page.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
})
// Responses 启用批（T16，缺口 15）：协议栏三选一——第三按钮可选 openai-responses、
// 保存持久化、卡片 tag 显示 Responses（后端 parseProviderInput 放行三选一）
test('Responses 协议三选一：添加 openai-responses 供应商保存成功', async ({ page }) => {
  await page.goto(`${BASE}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  await page.locator('.rbtn[data-tip="设置（⌘,）"]').click()
  await page.locator('.settings-nav button', { hasText: '服务提供方' }).click()
  await page.locator('.ai-service-panel > .group-title .add-btn', { hasText: '添加' }).click()

  // 协议栏第三按钮（排最后）——选中后 auth 自动定 bearer
  await page.locator('.ai-service-panel .protocol-btn', { hasText: 'Responses' }).click()
  const inputs = page.locator('.ai-service-panel > .form .text-input')
  await inputs.nth(0).fill('Responses 官方')
  await inputs.nth(1).fill('https://api.openai.local/v1')
  await inputs.nth(2).fill('sk-test-key-resp')
  await page.locator('.ai-service-panel > .form .save-btn').click()

  const card = page.locator('.ai-service-panel .provider-row', { hasText: 'Responses 官方' })
  await expect(card).toHaveCount(1)
  // tag 三值映射：openai-responses → 'Responses'（非 'OpenAI'）
  await expect(card.locator('.tag')).toHaveText('Responses')

  // 持久化核验：GET /api/providers 返回该条目且 protocol 字段保真
  const j = await (await page.request.get(`${BASE}/api/providers`)).json()
  const saved = j.providers.find((p: { name: string }) => p.name === 'Responses 官方')
  expect(saved).toMatchObject({ protocol: 'openai-responses', auth: 'bearer' })
  expect(saved.apiKey).toBe('')
})
