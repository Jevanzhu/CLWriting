/**
 * 全自动写章闭环（审查 §八⑨：e2e 补 auto-write spec + 新 mock 快路）。
 *
 * 独立 server（偏移 3，起停样板见 ./independent-server.ts），不污染 globalSetup 的 18999。
 * self-heal mock 快路（§六补齐）：写稿 → 机检 → 收工 → P1-1 自动 openTab 到编辑器，
 * 草稿正文可见（mock 产出已落盘 + 编辑器 buffer 加载）。
 */
import { test, expect } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'
import { startIndependentServer, type IndependentServer } from './independent-server.js'

let srv: IndependentServer

test.beforeAll(async () => {
  srv = await startIndependentServer({ tag: 'auto-write', offset: 3 })
})

test.afterAll(async () => {
  await srv.close()
})

test('全自动写章：mock 快路收工自动转编辑器（P1-1）', async ({ page }) => {
  attachPageErrorBaseline(page, 'auto-write')
  await page.goto(`${srv.base}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  // 工作台：mock 下 AI 可达，全自动写章可点
  // kk-P1-1：tooltip 同步 a20f8eb 新文案
  await page.locator('.rbtn[data-tip="AI 工作台 Beta"]').click()
  const autoBtn = page.locator('.workbench .btn.auto')
  await expect(autoBtn).toBeEnabled()

  // R66-40（十四轮）：先取 token + 判态——工作台 auto 按钮写的就是 state.nextChapter
  // （WorkbenchView chapter computed），记下目标章号供落盘断言按章核验
  // T2-3：GET 读端点也要求 token（boot 取，与下方批量连写用例同通道）
  const boot = await page.request.get(`${srv.base}/api/boot`)
  const token = (await boot.json()).token
  const stateHeaders = { headers: { 'x-studio-token': token } }
  const before = await page.request.get(`${srv.base}/api/books/长篇测试书/state`, stateHeaders)
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
  const ok = await page.request.get(`${srv.base}/api/books/长篇测试书/state`, stateHeaders)
  expect(ok.status()).toBe(200)
  const sb = await ok.json()
  expect(typeof sb.stateName, 'state 端点应回判态人话名').toBe('string')
  expect((sb.stateName as string).length).toBeGreaterThan(0)
  expect(typeof sb.humanMsg, 'state 端点应回判态提示语').toBe('string')

  // 长篇章文件名 = 章号 4 位-标题.md（documents/service updateChapterMeta 口径）；
  // 目标章已存在则原文件被覆写、不存在则新建——两种形态都按「000N-」前缀兜住
  const tree = await page.request.get(`${srv.base}/api/books/长篇测试书/tree?refresh=1`, stateHeaders)
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
      `${srv.base}/api/books/长篇测试书/file?file=${encodeURIComponent(p)}`,
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
  attachPageErrorBaseline(page, 'auto-write')
  await page.goto(`${srv.base}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()

  // boot 取 studio token（POST 需 x-studio-token）
  const boot = await page.request.get(`${srv.base}/api/boot`)
  const token = (await boot.json()).token

  const resp = await page.request.post(`${srv.base}/api/books/长篇测试书/auto-write`, {
    headers: { 'Content-Type': 'application/json', 'x-studio-token': token },
    data: { chapter: 3, batchSize: 2 },
  })
  expect(resp.status()).toBe(200)
  const body = await resp.json()
  expect(body.chapters).toEqual([3, 4])
  expect(body.batchSize).toBe(2)
})
