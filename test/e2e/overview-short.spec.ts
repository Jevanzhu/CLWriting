/**
 * P2-PROD-3：短篇概览节奏曲线（字数曲线）e2e。
 *
 * 背景：短篇与长篇已统一「章」概念，正文 fm 用 章号（无 篇号）。
 * 短篇 Overview 复用长篇 curve 面板（v-if rhythmData && curve.length），
 * 不按 kind 分支——本 spec 验证短篇集字数曲线正常渲染非空白。
 *
 * fixture：makeShortBook 的「短篇测试集」（2 章：雨夜门铃/红伞，均带 章号 fm）。
 * 独立 server（端口 19012）+ mock driver，不污染 globalSetup 的 18999。
 */
import { test, expect } from '@playwright/test'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../../src/studio/server/index.js'
import { makeDualTrackWorkdir, SHORT_BOOK } from '../studio/fixtures.js'

const PORT = 19012
const BASE = `http://127.0.0.1:${PORT}`
let server: http.Server
let workDir = ''
let userDataPath = ''
let prevDriver: string | undefined

test.beforeAll(async () => {
  prevDriver = process.env.CLWRITING_DRIVER
  process.env.CLWRITING_DRIVER = 'mock'
  workDir = makeDualTrackWorkdir()
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-e2e-ovshort-ud-'))
  server = startServer({ port: PORT, workDir, userDataPath, staticDir: join(process.cwd(), 'dist', 'web') })
  await new Promise<void>((r, reject) => {
    server.once('listening', () => r())
    // R64-40（十二轮）：固定端口被占给指因人话提示（X-36③ global-setup 同款——
    // 环境争用时裸 EADDRINUSE 栈难排查）
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[e2e overview-short] 端口 ${PORT} 已被占用——通常是上一次 e2e 未退干净或本地 dev 服务抢占。\n` +
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
  await new Promise<void>((r) => server.close(() => r()))
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

test('短篇概览：字数曲线面板非空白（2 章数据点 + 标题）', async ({ page }) => {
  // 进短篇集工作区（书架 → 点击书卡）
  await page.goto(`${BASE}/shelf`)
  await page.locator('.book-title', { hasText: SHORT_BOOK }).first().click()
  await expect(page.locator('.ws-shell')).toBeVisible()

  // ribbon 总览按钮 → 切到 overview
  await page.locator('.rbtn[data-tip*="总览"]').click()
  await expect(page.locator('.overview')).toBeVisible()

  // 字数曲线面板渲染（2 章数据点 + 标题非空）
  const panel = page.locator('.panel', { hasText: '字数曲线' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.head-legend')).toContainText('2 章')
  await expect(panel.locator('svg[aria-label="字数曲线"]')).toBeVisible()
  // 2 章数据点 → 面积/描边 path 至少 2 条（非空白证明有数据）
  await expect(panel.locator('.chart-svg path')).toHaveCount(2)
})
