/**
 * D1（批 4）用量卡片 e2e：开书默认进工作台 → 「AI 用量」卡可见（空态 → 自种事件 → 表格态）。
 *
 * R76-10（二十四轮 F 域）：前置状态自建 + 独立 server。旧版挂共享 server 且两臂条件
 * 分支（empty/table 取决于「前序 AI spec 是否留事件」）——实测共享 server 未传
 * userDataPath，trace-stats 恒空，表格臂结构性不可达：spec 一直静默跑在空态弱臂上
 * （R76-10 所指「覆盖被上游行为静默切弱臂」的实锤）。改 ai-provider 同款独立 server
 * （自有 workDir + userDataPath + mock driver）：
 * - 空态臂：全新环境（零事件）→ 「暂无 AI 调用记录」确定性可见；
 * - 表格臂：beforeAll 直打 autotag API（mock driver 一次真实 runSpec 记账，「不落信封；
 *   前端写 fm」无盘副作用）→ 表格 + ≥1 行任务数据确定性可见。
 */
import { test, expect } from '@playwright/test'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../../src/studio/server/index.js'
import { makeDualTrackWorkdir } from '../studio/fixtures.js'
import { e2ePort } from './e2e-ports.js'
import { attachPageErrorBaseline } from './page-error-baseline.js'

// R73-75（批 F-8）：端口基址派生（偏移 4 此前未用；偏移表见 e2e-ports.ts）
const PORT = e2ePort(4)
const BASE = `http://127.0.0.1:${PORT}`
let server: http.Server
let workDir = ''
let userDataPath = ''
let studioToken = ''

test.beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = makeDualTrackWorkdir()
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-e2e-usage-ud-'))
  server = startServer({ port: PORT, workDir, userDataPath, staticDir: join(process.cwd(), 'dist', 'web') })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', (err) => reject(err))
  })
  // T2-3：写端点要求 token——boot 取一次
  const boot = await (await fetch(`${BASE}/api/boot`)).json()
  studioToken = boot.token
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  delete process.env['CLWRITING_DRIVER']
})

async function openWorkbench(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${BASE}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByRole('button', { name: '工作台' }).click()
}

test('用量卡空态：零事件 → 「暂无 AI 调用记录」（确定性弱臂）', async ({ page }) => {
  attachPageErrorBaseline(page, 'usage-card')
  await openWorkbench(page)
  await expect(page.locator('.usage-card')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.usage-card .usage-title')).toContainText('AI 用量')
  // R73-70（F-3）：「统计加载中」必须退场（加载中空壳也挂 .usage-empty，不算 settle）
  await expect(page.locator('.usage-card .usage-empty', { hasText: '统计加载中' })).toHaveCount(0)
  // 全新环境零事件 → 真实空态文案（区分于加载中/渲染异常的空壳）
  await expect(page.locator('.usage-card .usage-empty')).toContainText('暂无 AI 调用记录')
})

test('用量卡表格态：自种 autotag 事件 → 表格 + ≥1 行任务数据（确定性强臂）', async ({ page }) => {
  // 种事件：0001 的 autotag（mock driver）→ llm calls 库记一条本书事件（本 spec 私有
  // userDataPath，不受共享环境影响；autotag 不写盘——返回 tags 由前端落 fm）。
  // docId 直接读私有 workDir 的文档清单（fs 可达，免多一跳 API）
  const manifest = readFileSync(
    join(workDir, '长篇', '长篇测试书', '项目', '文档清单.jsonl'),
    'utf-8',
  )
  const docId = manifest
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { id: string; path?: string })
    .find((e) => (e.path ?? '').includes('0001-'))!.id
  const resp = await fetch(
    `${BASE}/api/books/${encodeURIComponent('长篇测试书')}/documents/${encodeURIComponent(docId)}/autotag`,
    { method: 'POST', headers: { 'x-studio-token': studioToken } },
  )
  expect(resp.ok, `autotag 应成功（实测 ${resp.status}）`).toBe(true)

  attachPageErrorBaseline(page, 'usage-card')
  await openWorkbench(page)
  await expect(page.locator('.usage-card')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.usage-card .usage-empty', { hasText: '统计加载中' })).toHaveCount(0)
  // 空态不再可达（事件已种）——表格 + 至少一行任务数据（表头壳不算渲染成功）
  await expect(page.locator('.usage-card .usage-empty')).toHaveCount(0)
  await expect(page.locator('.usage-card table tbody tr').first()).toBeVisible()
})
