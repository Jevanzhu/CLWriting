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
import { rmSync } from 'node:fs'
import { startServer } from '../../src/studio/server/index.js'
import { makeDualTrackWorkdir } from '../studio/fixtures.js'
import { e2ePort } from './e2e-ports.js'

// R73-75（批 F-8）：端口基址派生（CLW_E2E_PORT_BASE+1，旧硬编码 19000；偏移表见 e2e-ports.ts）
const PORT = e2ePort(1)
const BASE = `http://127.0.0.1:${PORT}`
let server: http.Server
// R65-60（F-4）：workDir 提到模块级——此前 afterAll 只清环境变量不清书目录，临时区残留
let workDir = ''

test.beforeAll(async () => {
  process.env['CLWRITING_E2E_AI_DOWN'] = '1'
  workDir = makeDualTrackWorkdir()
  server = startServer({ port: PORT, workDir, staticDir: join(process.cwd(), 'dist', 'web') })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    // R64-40（十二轮）：固定端口被占给指因人话提示（X-36③ global-setup 同款——
    // 环境争用时裸 EADDRINUSE 栈难排查）
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[e2e ai-degrade] 端口 ${PORT} 已被占用——通常是上一次 e2e 未退干净或本地 dev 服务抢占。\n` +
            `排查：lsof -i :${PORT} 查占用进程并 kill 后重跑。`,
        )
      }
      reject(err)
    })
  })
})

test.afterAll(async () => {
  delete process.env['CLWRITING_E2E_AI_DOWN']
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

test('AI 不可达：编辑保存照常 + 辅助置灰', async ({ page }) => {
  // ① ai-status 报告不可达（T2-3：GET 读端点要求 token，boot 取）
  const boot = await page.request.get(`${BASE}/api/boot`)
  const token = (await boot.json()).token
  const r = await page.request.get(`${BASE}/api/ai-status`, { headers: { 'x-studio-token': token } })
  expect(await r.json()).toMatchObject({ available: false })

  await page.goto(`${BASE}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  // ② 编辑器不依赖 AI：选章编辑 + ⌘S 保存成功
  await page.getByText('初入宗门').first().click()
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible()
  await cm.click()
  await page.keyboard.type('降级时仍可编辑')
  await page.keyboard.press('ControlOrMeta+s') // R64-35（十二轮）：跨平台——非 mac 上 Meta+s 静默不触发（假红）
  await expect(page.locator('.save-group .save-btn')).toContainText('已保存', { timeout: 5_000 })

  // ③ 切工作台 → AI 降级警告条（生成按钮 v-if=!running，running 态不渲染，故以警告条为降级标志）
  // kk-P1-1：tooltip 同步 a20f8eb 新文案（工作台（AI 写作）→ AI 工作台 Beta）
  await page.locator('.rbtn[data-tip="AI 工作台 Beta"]').click()
  await expect(page.locator('.ai-warn')).toContainText('不可用')
})
