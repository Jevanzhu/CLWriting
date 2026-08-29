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
import { e2ePort } from './e2e-ports.js'
import { attachPageErrorBaseline } from './page-error-baseline.js'

// R73-75（批 F-8）：端口基址派生（CLW_E2E_PORT_BASE+2，旧硬编码 19001；偏移表见 e2e-ports.ts）
const PORT = e2ePort(2)
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
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    // R64-40（十二轮）：固定端口被占给指因人话提示（X-36③ global-setup 同款——
    // 环境争用时裸 EADDRINUSE 栈难排查）
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[e2e ai-provider] 端口 ${PORT} 已被占用——通常是上一次 e2e 未退干净或本地 dev 服务抢占。\n` +
            `排查：lsof -i :${PORT} 查占用进程并 kill 后重跑。`,
        )
      }
      reject(err)
    })
  })
})

test.afterAll(async () => {
  if (prevDriver === undefined) delete process.env.CLWRITING_DRIVER
  else process.env.CLWRITING_DRIVER = prevDriver
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
  // R65-60（F-4）：workDir 同清（对齐 auto-write）
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

// T2-3：GET /api/* 读端点要求 token——boot 取一次缓存，直打 API 的断言统一带 x-studio-token
let studioToken = ''
test.beforeAll(async () => {
  const boot = await (await fetch(`${BASE}/api/boot`)).json()
  studioToken = boot.token
})

test('添加→测试→双供应商切换→工作台解灰 全流程', async ({ page }) => {
  attachPageErrorBaseline(page, 'ai-provider')
  await page.goto(`${BASE}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  // 打开设置 → 服务提供方 tab（提供方面板在「AI 提供方」tab，非「AI 功能」tab）
  await page.locator('.rbtn[data-tip="设置（⌘,）"]').click()
  await page.locator('.settings-nav button', { hasText: '服务提供方' }).click()

  // 空态 → 添加第一个供应商（DSH 编辑器：主字段 = API Key；「自定义设置」折叠内含名称/API 地址）
  await page.locator('.ai-service-panel > .group-title .add-btn', { hasText: '添加' }).click()
  const addCard = page.locator('.ai-service-panel .add-provider-card')
  // 主字段：API Key（details 折叠时唯一可见的 text-input）
  await addCard.locator('.form .text-input').nth(0).fill('sk-test-key-1234')
  // 展开「自定义设置」→ 填名称 + API 地址（text-input 次序：API Key, 名称, API 地址）
  await addCard.locator('.adv-summary').click()
  await addCard.locator('.form .text-input').nth(1).fill('我的中转')
  await addCard.locator('.form .text-input').nth(2).fill('https://openai.local/v1')
  await addCard.locator('.form .save-btn').click()

  let card = page.locator('.ai-service-panel .provider-row')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('我的中转')

  // 第一个自动成为当前（POST 首条语义）：「当前」徽章 + 无「设为当前启用」按钮
  //（阶段 14 IA 重组：旧 .dot.on 指示点改为 .current-badge 徽章——AiProviderList）
  await expect(card.locator('.current-badge')).toContainText('当前')

  // 测试连接：mock 短路返回全能力 → caps 徽章出现
  await card.locator('.mini-btn[data-tip="测试连接"]').click()
  await expect(card.locator('.caps-badge')).toContainText('已连接', { timeout: 10_000 })

  // 添加第二个供应商
  await page.locator('.ai-service-panel > .group-title .add-btn', { hasText: '添加' }).click()
  const addCard2 = page.locator('.ai-service-panel .add-provider-card')
  await addCard2.locator('.form .text-input').nth(0).fill('sk-test-key-9999')
  await addCard2.locator('.adv-summary').click()
  await addCard2.locator('.form .text-input').nth(1).fill('备用中转')
  await addCard2.locator('.form .text-input').nth(2).fill('https://backend.local/v1')
  await addCard2.locator('.form .save-btn').click()

  await expect(page.locator('.ai-service-panel .provider-row')).toHaveCount(2)
  card = page.locator('.ai-service-panel .provider-row', { hasText: '备用中转' })
  // 第二个不是 current → 有「设为当前启用」按钮；点击切换（P0-1：PUT /current 不被 /:id 遮蔽）
  await card.locator('.mini-btn[data-tip="测试连接"]').click()
  await expect(card.locator('.caps-badge')).toContainText('已连接', { timeout: 10_000 })
  await card.locator('.mini-btn[data-tip="设为当前启用"]').click()
  await expect(card.locator('.current-badge')).toContainText('当前')

  // 后端 ai-status 即刻可达（P0-2 无缓存）
  const j = await (await page.request.get(`${BASE}/api/ai-status`, { headers: { 'x-studio-token': studioToken } })).json()
  expect(j).toMatchObject({ available: true })

  // —— RAG 提供方：切到面板内「RAG 提供方」分页管理 ——
  await page.locator('.panel-tab', { hasText: 'RAG 提供方' }).click()
  //（阶段 14 IA 重组：列表挂 .group-title；.rag-provider-section 现为编辑器卡内层）
  await page.locator('.group-title .add-btn', { hasText: '添加' }).click()
  const ragInputs = page.locator('.ai-service-panel .add-provider-card .form .text-input')
  await ragInputs.nth(0).fill('嵌入验证')
  await ragInputs.nth(1).fill('https://embed.local/v1/embeddings')
  await ragInputs.nth(2).fill('text-embedding-3-small')
  await ragInputs.nth(3).fill('sk-embed-key-1')
  await page.locator('.ai-service-panel .add-provider-card .form .save-btn').click()

  const ragCard = page.locator('.ai-service-panel .provider-row')
  await expect(ragCard).toHaveCount(1)
  await expect(ragCard).toContainText('嵌入验证')
  await expect(ragCard).toContainText('text-embedding-3-small')
  // KEY 已完全隐藏：卡片既不回明文也不回脱敏残留（安全不变式）
  await expect(ragCard).not.toContainText('sk-embed-key-1')
  await expect(ragCard).not.toContainText('sk-e...')

  // —— 「本书」页：知识检索「本书使用独立设定」+ 启用检索 + 选刚建的 RAG 提供方 → book.yaml 落 rag ——
  // （IA 重组：全局默认在「智能分析」页写 global.json 不落 book.yaml；书级引用走本书覆盖组——
  //   全书三组「本书使用独立设定」，须先用组头（cfg-card-head 知识检索）收窄再点组内开关）
  await page.locator('.settings-nav button', { hasText: '本书' }).click()
  const ragGroup = page.locator('.cfg-card-head', { hasText: '知识检索' }).locator(' + .cfg-card')
  await ragGroup.locator('.setting-item', { hasText: '本书使用独立设定' }).locator('.switch').click()
  await ragGroup.locator('.setting-item', { hasText: '启用检索' }).locator('.switch').click()
  const ragList = await (await page.request.get(`${BASE}/api/rag-providers`, { headers: { 'x-studio-token': studioToken } })).json()
  expect(ragList.ragProviders).toHaveLength(1)
  await ragGroup.locator('.rag-prov-select').selectOption(ragList.ragProviders[0].id)

  // GET 信封是 {config}；saveConfig 的 PUT 串行但在途，用 poll 等落盘
  await expect
    .poll(async () => {
      const c = await (await page.request.get(`${BASE}/api/books/长篇测试书/config`, { headers: { 'x-studio-token': studioToken } })).json()
      return c.config?.rag ?? null
    })
    .toMatchObject({ enabled: true, provider: ragList.ragProviders[0].id })

  // 关设置 → 工作台「生成」按钮解灰（不再 disabled）
  await page.locator('.settings-modal .close-btn').click()
  // kk-P1-1：tooltip 同步 a20f8eb 新文案
  await page.locator('.rbtn[data-tip="AI 工作台 Beta"]').click()
  await expect(page.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
})
// Responses 启用批（T16，缺口 15）：协议栏三选一——第三按钮可选 openai-responses、
// 保存持久化、卡片 tag 显示 Responses（后端 parseProviderInput 放行三选一）
test('Responses 协议三选一：添加 openai-responses 供应商保存成功', async ({ page }) => {
  attachPageErrorBaseline(page, 'ai-provider')
  await page.goto(`${BASE}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  await page.locator('.rbtn[data-tip="设置（⌘,）"]').click()
  await page.locator('.settings-nav button', { hasText: '服务提供方' }).click()
  await page.locator('.ai-service-panel > .group-title .add-btn', { hasText: '添加' }).click()
  const addCard = page.locator('.ai-service-panel .add-provider-card')
  // 主字段：API Key（先填，details 折叠）
  await addCard.locator('.form .text-input').nth(0).fill('sk-test-key-resp')
  // 展开「自定义设置」→ 协议栏第三按钮（排最后）——选中后 auth 自动定 bearer
  await addCard.locator('.adv-summary').click()
  await addCard.locator('.protocol-btn', { hasText: 'Responses' }).click()
  await addCard.locator('.form .text-input').nth(1).fill('Responses 官方')
  await addCard.locator('.form .text-input').nth(2).fill('https://api.openai.local/v1')
  await addCard.locator('.form .save-btn').click()

  const card = page.locator('.ai-service-panel .provider-row', { hasText: 'Responses 官方' })
  await expect(card).toHaveCount(1)
  // tag 三值映射：openai-responses → 'Responses'（非 'OpenAI'）
  await expect(card.locator('.tag')).toHaveText('Responses')

  // 持久化核验：GET /api/providers 返回该条目且 protocol 字段保真
  const j = await (await page.request.get(`${BASE}/api/providers`, { headers: { 'x-studio-token': studioToken } })).json()
  const saved = j.providers.find((p: { name: string }) => p.name === 'Responses 官方')
  expect(saved).toMatchObject({ protocol: 'openai-responses', auth: 'bearer' })
  expect(saved.apiKey).toBe('')
})
