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
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    // R64-40（十二轮）：固定端口被占给指因人话提示（X-36③ global-setup 同款——
    // 环境争用时裸 EADDRINUSE 栈难排查）
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[e2e auto-write] 端口 ${PORT} 已被占用——通常是上一次 e2e 未退干净或本地 dev 服务抢占。\n` +
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
})

test('全自动写章：mock 快路收工自动转编辑器（P1-1）', async ({ page }) => {
  await page.goto(`${BASE}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  // 工作台：mock 下 AI 可达，全自动写章可点
  // kk-P1-1：tooltip 同步 a20f8eb 新文案
  await page.locator('.rbtn[data-tip="AI 工作台 Beta"]').click()
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
  // T2-3：GET 读端点也要求 token（boot 取，与下方批量连写用例同通道）
  const boot = await page.request.get(`${BASE}/api/boot`)
  const token = (await boot.json()).token
  const ok = await page.request.get(`${BASE}/api/books/长篇测试书/state`, {
    headers: { 'x-studio-token': token },
  })
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
