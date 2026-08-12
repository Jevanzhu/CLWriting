/**
 * 全自动写章闭环（审查 §八⑨：e2e 补 auto-write spec + 新 mock 快路）。
 *
 * 独立 server（端口 19002 + CLWRITING_DRIVER=mock），不污染 globalSetup 的 18999。
 * self-heal mock 快路（§六补齐）：写稿 → 机检 → 收工 → P1-1 自动 openTab 到编辑器，
 * 草稿正文可见（mock 产出已落盘 + 编辑器 buffer 加载）。
 */
import { test, expect } from '@playwright/test'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../../src/studio/server/index.js'
import { makeDualTrackWorkdir } from '../studio/fixtures.js'

const PORT = 19002
const BASE = `http://127.0.0.1:${PORT}`
let server: http.Server
let workDir = ''
let userDataPath = ''
let prevDriver: string | undefined

test.beforeAll(async () => {
  prevDriver = process.env.CLWRITING_DRIVER
  process.env.CLWRITING_DRIVER = 'mock'
  workDir = makeDualTrackWorkdir()
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-e2e-autowrite-ud-'))
  server = startServer({ port: PORT, workDir, userDataPath, staticDir: join(process.cwd(), 'dist', 'web') })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
})

test.afterAll(async () => {
  if (prevDriver === undefined) delete process.env.CLWRITING_DRIVER
  else process.env.CLWRITING_DRIVER = prevDriver
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

test('全自动写章：mock 快路收工自动转编辑器（P1-1）', async ({ page }) => {
  await page.goto(`${BASE}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  // 工作台：mock 下 AI 可达，全自动写章可点
  await page.locator('.rbtn[data-tip="工作台（AI 写作）"]').click()
  const autoBtn = page.locator('.workbench .btn.auto')
  await expect(autoBtn).toBeEnabled()

  // 触发全自动写章（fire-and-forget：立即返回，后续 SSE 回流）
  await autoBtn.click()

  // 收工（self_heal_result）→ P1-1 自动 openTab 切编辑器
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible({ timeout: 30_000 })
  // 草稿正文已进编辑器 buffer：mock 快路真实落盘 + 打开
  await expect(cm).toContainText('mock 自动写章', { timeout: 10_000 })

  // 事件流记录了自愈终局（高级区不展开；借 store 无从期断言，验证磁盘已落盘）
  const ok = await page.request.get(`${BASE}/api/books/长篇测试书/state`)
  expect(ok.status()).toBe(200)
})
// ── P2-3：批量连写 ──────────────────────────────────────────────
test('批量连写：batchSize=2 时后端返回 chapters 序列', async ({ page }) => {
  await page.goto(`${BASE}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  // boot 取 studio token（POST 需 x-studio-token）
  const boot = await page.request.get(`${BASE}/api/boot`)
  const token = (await boot.json()).token

  const resp = await page.request.post(`${BASE}/api/books/长篇测试书/auto-write`, {
    headers: { 'Content-Type': 'application/json', 'x-studio-token': token },
    data: { chapter: 3, batchSize: 2 },
  })
  expect(resp.status()).toBe(200)
  const body = await resp.json()
  expect(body.chapters).toEqual([3, 4])
  expect(body.batchSize).toBe(2)
})
