/**
 * T1.3 409 冲突出路（M11 E1）：外部改磁盘 → 前端保存撞 REVISION_CONFLICT → 重载/覆盖双出路。
 *
 * 触发：前端 doc.open 持有旧 baselineRevision → spec 进程 fs.writeFileSync 改磁盘（revision 变）
 *      → 前端编辑 + ⌘S 带旧 revision → 服务端 computeRevision(磁盘) ≠ expectedRevision → 409。
 *
 * 两出路各一测，分用两章避免磁盘状态互相污染：
 * - 重载远端（0001-初入宗门）：丢本地，cm 内容变远端
 * - 覆盖远端（0002-玉佩之秘）：丢远端，磁盘变本地
 */
import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// workDir 由 globalSetup 注入 env；须 lazy 读取——收集阶段（--list/单跑）不跑 globalSetup，顶层读会炸
function chapterPath(file: string): string {
  return join(process.env['CLWRITING_E2E_WORKDIR']!, '长篇', '长篇测试书', '写作', '正文', file)
}
const CHAPTER_1 = (): string => chapterPath('0001-初入宗门.md')
const CHAPTER_2 = (): string => chapterPath('0002-玉佩之秘.md')

// 记录原始内容，afterAll 恢复（防跨 spec 状态泄漏）
let orig1: string
let orig2: string

test.beforeAll(() => {
  orig1 = readFileSync(CHAPTER_1(), 'utf-8')
  orig2 = readFileSync(CHAPTER_2(), 'utf-8')
})

test.afterAll(() => {
  writeFileSync(CHAPTER_1(), orig1, 'utf-8')
  writeFileSync(CHAPTER_2(), orig2, 'utf-8')
})

async function openChapter(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText(name).first().click()
  await expect(page.locator('.cm-content')).toBeVisible()
}

async function provokeConflict(page: import('@playwright/test').Page, chapter: string, marker: string): Promise<void> {
  // ① 前端已 open（持有旧 revision）→ 外部改磁盘
  const external = readFileSync(chapter, 'utf-8').replace(marker, '【外部改写】')
  writeFileSync(chapter, external)
  // ② 前端编辑 + ⌘S → 撞冲突
  const cm = page.locator('.cm-content')
  await cm.click()
  await page.keyboard.type('本地改动')
  await page.keyboard.press('Meta+s')
  await expect(page.locator('.conflict-btn').first()).toBeVisible({ timeout: 5_000 })
}

test('冲突 → 重载远端（丢本地取远端）', async ({ page }) => {
  await openChapter(page, '初入宗门')
  await provokeConflict(page, CHAPTER_1(), '林远踏入宗门')

  await page.locator('.conflict-btn').first().click()

  // cm 内容变远端（含【外部改写】，不含本地改动）
  const cm = page.locator('.cm-content')
  await expect(cm).toContainText('【外部改写】', { timeout: 5_000 })
  await expect(cm).not.toContainText('本地改动')
})

test('冲突 → 覆盖远端（丢远端写本地）', async ({ page }) => {
  await openChapter(page, '玉佩之秘')
  await provokeConflict(page, CHAPTER_2(), '玉佩突然爆发灵光')

  await page.locator('.conflict-btn.danger').click()

  // 保存回正常态
  await expect(page.locator('.save-group .save-btn')).toContainText('已保存', { timeout: 5_000 })
  // 磁盘变本地内容（含本地改动，不含【外部改写】）
  const disk = readFileSync(CHAPTER_2(), 'utf-8')
  expect(disk).toContain('本地改动')
  expect(disk).not.toContain('【外部改写】')
})
