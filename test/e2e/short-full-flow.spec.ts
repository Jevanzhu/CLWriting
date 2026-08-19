/**
 * P0-1 短篇手测 —— UI 全流程（mock driver，不调大模型）。
 *
 * 覆盖方案「短篇功能全面对齐」手测路径的机器可验全部环节：
 * 1. 书架新建短篇书（kind=short）
 * 2. 开书对话：短篇步骤分流（无卷纲/有短篇专属）→ 各步 AI 生成 + 保存
 * 3. 全自动写章（self-heal mock 快路）→ 草稿落盘自动转编辑器
 * 4. 机检零红
 * 5. 三审出意见 + 通过 verdict
 * 6. 定稿 → 树节点 final
 *
 * 独立 server（端口 19013）+ CLWRITING_DRIVER=mock，不污染 globalSetup 的 18999。
 */
import { test, expect } from '@playwright/test'
import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../../src/studio/server/index.js'

const PORT = 19013
const BASE = `http://127.0.0.1:${PORT}`
let server: http.Server
let workDir = ''
let userDataPath = ''
let prevDriver: string | undefined

test.beforeAll(async () => {
  prevDriver = process.env.CLWRITING_DRIVER
  process.env.CLWRITING_DRIVER = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clw-e2e-shortflow-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), '')
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-e2e-shortflow-ud-'))
  server = startServer({ port: PORT, workDir, userDataPath, staticDir: join(process.cwd(), 'dist', 'web') })
  await new Promise<void>((r) => server.once('listening', () => r()))
})

test.afterAll(async () => {
  if (prevDriver === undefined) delete process.env.CLWRITING_DRIVER
  else process.env.CLWRITING_DRIVER = prevDriver
  await new Promise<void>((r) => server.close(() => r()))
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

const BOOK = '手测短篇集'

test('短篇 UI 全流程：建书 → 开书 → 写章 → 机检 → 三审 → 定稿', async ({ page }) => {
  // ── 1. 书架新建短篇书 ──
  await page.goto(`${BASE}/shelf`)
  await expect(page.locator('.head-title', { hasText: '书架' })).toBeVisible()
  await page.locator('.btn.primary', { hasText: '新建书' }).first().click()
  await page.locator('.kind-btn', { hasText: '短篇' }).click()
  await page.locator('.input').fill(BOOK)
  await page.locator('.btn.primary', { hasText: '创建' }).click()
  // 建书成功 → 自动跳转书工作区
  await expect(page).toHaveURL(/\/book\//, { timeout: 10_000 })
  await expect(page.locator('.ws-shell')).toBeVisible()

  // ── 2. 开书对话：短篇步骤分流 ──
  // 切「开书对话」tab；kk-P1-1：tooltip 同步 a20f8eb 新文案
  await page.locator('.rbtn[data-tip="开书对话 Beta"]').click()
  await expect(page.locator('.onboard')).toBeVisible()
  // 短篇：无「卷纲」步骤，有「短篇专属」组
  await expect(page.locator('.rail-item', { hasText: '卷纲' })).toHaveCount(0)
  await expect(page.locator('.rail-group-label', { hasText: '短篇专属' })).toBeVisible()

  // 跑「短篇专属 → 首章细纲」一步：生成 + 保存
  await page.locator('.rail-item', { hasText: '首章细纲' }).click()
  await page.locator('.btn.primary', { hasText: '生成' }).click()
  await expect(page.locator('.ob-panel textarea, .ob-panel .cm-content, .ob-panel .editor-area').first()).toBeVisible({ timeout: 15_000 })
  // 生成后保存
  await page.locator('.btn.primary', { hasText: '保存' }).click()
  await expect(page.getByText('已保存')).toBeVisible({ timeout: 10_000 })

  // ── 3. 工作台：全自动写章 ──
  // kk-P1-1：tooltip 同步 a20f8eb 新文案
  await page.locator('.rbtn[data-tip="AI 工作台 Beta"]').click()
  const autoBtn = page.locator('.workbench .btn.auto')
  await expect(autoBtn).toBeEnabled()
  await autoBtn.click()
  // 收工 → 自动转编辑器（mock 快路真实落盘）
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible({ timeout: 30_000 })
  await expect(cm).toContainText('mock 自动写章', { timeout: 10_000 })

  // ── 4. 机检零红 ──
  // 先确认落盘的正文 fm 含 钩子类型/情绪定位（短篇必填字段）
  const bookRoot = join(workDir, '短篇', BOOK)
  const bodyDir = join(bookRoot, '写作', '正文')
  // 短篇正文落在「写作/正文/[卷]/000N-*.md」，递归找
  const fs = await import('node:fs')
  const findAllMd = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? findAllMd(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : [],
        )
      : []
  const bodyFiles = findAllMd(bodyDir)
  expect(bodyFiles.length).toBeGreaterThan(0)
  const bodyContent = readFileSync(bodyFiles[0]!, 'utf-8')
  // mock 写章产出统一调 assembleChapter → 短篇 fm 含下字段
  const hasFm = /钩子类型:/.test(bodyContent) && /情绪定位:/.test(bodyContent)
  expect(hasFm).toBe(true)

  // 机检 tab（右栏第 3 个 .right-tab：信息/审阅/校对）
  await page.locator('.right-tabs .right-tab').nth(2).click()
  // 机检自动跑 → 无红
  await expect(page.locator('.check-panel')).toBeVisible()
  // 机检结果区：无红项（mock 正文无禁词/短篇专属项）
  await expect(page.locator('.check-panel .check-item--red')).toHaveCount(0, { timeout: 10_000 })

  // ── 5. 三审 ──
  await page.locator('.right-tabs .right-tab').nth(1).click()
  await page.locator('.rev-run-btn').click()
  await expect(page.locator('.review-panel .rev-item--yellow').first()).toContainText('mock 问题', { timeout: 15_000 })
  await page.locator('.review-panel .rev-verdict-btn').first().click()
  await expect(page.locator('.review-panel .rev-verdict-badge')).toHaveText('通过')

  // ── 6. 定稿（首次定稿：mock 写章后 draft 态正文 → 允许）──
  // 回到编辑器 tab 选章 → 定稿按钮（修复后 draft 态正文可首次定稿）
  await page.locator('.right-tabs .right-tab').nth(0).click()
  const finalizeBtn = page.locator('.finalize-btn')
  await expect(finalizeBtn).toBeVisible()
  await finalizeBtn.click()
  await expect(page.getByText('已定稿')).toBeVisible({ timeout: 10_000 })
  // 树节点 final（dot-green）——mock 写章产出标题「mock 章节标题」；先展开卷目录
  // 默认展开一级目录 + 写作/正文，章在「第一卷」下 → 点目录行展开
  const volRow = page.locator('.tree-item', { hasText: '第一卷' }).first()
  if (await volRow.count()) await volRow.click()
  const treeRow = page.locator('.tree-item').filter({ hasText: 'mock 章节标题' }).first()
  await expect(treeRow.locator('.dot.dot-green')).toBeVisible({ timeout: 10_000 })
})