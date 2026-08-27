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
  // R65-60（F-4）：workDir 同清——此前只清 userData，双轨书目录残留 test-results 外的临时区
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

test('全自动写章：mock 快路收工自动转编辑器（P1-1）', async ({ page }) => {
  await page.goto(`${BASE}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  // 工作台：mock 下 AI 可达，全自动写章可点
  // kk-P1-1：tooltip 同步 a20f8eb 新文案
  await page.locator('.rbtn[data-tip="AI 工作台 Beta"]').click()
  const autoBtn = page.locator('.workbench .btn.auto')
  await expect(autoBtn).toBeEnabled()

  // R66-40（十四轮）：先取 token + 判态——工作台 auto 按钮写的就是 state.nextChapter
  // （WorkbenchView chapter computed），记下目标章号供落盘断言按章核验
  // T2-3：GET 读端点也要求 token（boot 取，与下方批量连写用例同通道）
  const boot = await page.request.get(`${BASE}/api/boot`)
  const token = (await boot.json()).token
  const stateHeaders = { headers: { 'x-studio-token': token } }
  const before = await page.request.get(`${BASE}/api/books/长篇测试书/state`, stateHeaders)
  expect(before.status()).toBe(200)
  const target = (await before.json()).nextChapter as number
  expect(target).toBeGreaterThanOrEqual(1)

  // 触发全自动写章（fire-and-forget：立即返回，后续 SSE 回流）
  await autoBtn.click()

  // 收工（self_heal_result）→ P1-1 自动 openTab 切编辑器
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible({ timeout: 30_000 })
  // 草稿正文已进编辑器 buffer：mock 快路真实落盘 + 打开
  await expect(cm).toContainText('mock 自动写章', { timeout: 10_000 })

  // R66-40（十四轮）：原断言只核 state 端点 200，注释却称「验证磁盘已落盘」——
  // 200 只证明路由活着，不证明写章闭环产物在盘上。补两口硬断言：
  // ① state 响应体语义非空（判态真实产出）；② 直接读目标章文件内容含 mock 正文。
  const ok = await page.request.get(`${BASE}/api/books/长篇测试书/state`, stateHeaders)
  expect(ok.status()).toBe(200)
  const sb = await ok.json()
  expect(typeof sb.stateName, 'state 端点应回判态人话名').toBe('string')
  expect((sb.stateName as string).length).toBeGreaterThan(0)
  expect(typeof sb.humanMsg, 'state 端点应回判态提示语').toBe('string')

  // 长篇章文件名 = 章号 4 位-标题.md（documents/service updateChapterMeta 口径）；
  // 目标章已存在则原文件被覆写、不存在则新建——两种形态都按「000N-」前缀兜住
  const tree = await page.request.get(`${BASE}/api/books/长篇测试书/tree?refresh=1`, stateHeaders)
  expect(tree.status()).toBe(200)
  const nodes = (await tree.json()).nodes as Array<{ path: string; children?: unknown[] }>
  const allPaths: string[] = []
  const collect = (ns: Array<{ path: string; children?: unknown[] }>): void => {
    for (const n of ns) {
      allPaths.push(n.path)
      if (Array.isArray(n.children)) collect(n.children as Array<{ path: string; children?: unknown[] }>)
    }
  }
  collect(nodes)
  const pad = String(target).padStart(4, '0')
  const chapterFiles = allPaths.filter((p) => p.startsWith('写作/正文/') && p.includes(`/${pad}-`))
  expect(chapterFiles.length, `落盘后树上应有目标章 ${pad} 的文件节点`).toBeGreaterThan(0)

  let landed = false
  for (const p of chapterFiles) {
    const file = await page.request.get(
      `${BASE}/api/books/长篇测试书/file?file=${encodeURIComponent(p)}`,
      stateHeaders,
    )
    expect(file.status(), `读回 ${p}`).toBe(200)
    const body = (await file.json()) as { content: string }
    if (body.content.includes('mock 自动写章')) landed = true
  }
  expect(landed, '目标章文件正文应含 mock 自动写章产出（终稿真实落盘）').toBe(true)
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
