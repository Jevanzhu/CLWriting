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
import { attachPageErrorBaseline, dismissStartupNotices } from './page-error-baseline.js'

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

// 四轮-F401（2026-09-18 全量源码独立重评四轮修复批）：恢复防御对齐 edit-save.spec.ts
// 同款（R0911-G-P3-3 先例）——原裸 writeFileSync 两连写无守卫：第二步抛错会中断后续
// 恢复且零留痕，共享单一 workDir 的串行契约下「前序 spec 该恢复的状态没恢复」会让
// 下游 spec 无因红。每步恢复各自 try/catch + [e2e-restore] 结构化标记（CI 日志可
// grep 定位），失败不阻断后续恢复步骤。
function reportRestoreFailure(step: string, e: unknown): void {
  console.error(
    `[e2e-restore] conflict afterAll「${step}」恢复失败：${e instanceof Error ? e.message : String(e)}（不阻断；下游 spec 可能受影响）`,
  )
}

test.afterAll(() => {
  try {
    writeFileSync(CHAPTER_1(), orig1, 'utf-8')
  } catch (e) {
    reportRestoreFailure('0001-初入宗门 原文恢复', e)
  }
  try {
    writeFileSync(CHAPTER_2(), orig2, 'utf-8')
  } catch (e) {
    reportRestoreFailure('0002-玉佩之秘 原文恢复', e)
  }
})

async function openChapter(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.goto('/')
  // 启动通告横幅（全量跑时前序 spec 动过磁盘 → repair-books 自愈通告弹横幅）占位推迟
  // 编辑器挂载；打开书前关掉（单跑 fixture 干净不弹，幂等静默）
  await dismissStartupNotices(page)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  // R33 修复（三十三轮）：等书页路由到位后再找章节名——getByText 在书架页也匹
  // hero-recent「最近·章名」，导航未完成时取书架页元素点，导致编辑器挂载期待落空。
  await page.waitForURL('**/book/**')
  await page.getByText(name).first().click()
  // kk 观察：CI 慢速 runner 冷启挂载可超默认 10s，编辑器挂载断言统一放宽（见 check.spec 注）
  await expect(page.locator('.cm-content')).toBeVisible({ timeout: 20_000 })
}

async function provokeConflict(page: import('@playwright/test').Page, chapter: string, marker: string): Promise<void> {
  // ① 前端已 open（持有旧 revision）→ 外部改磁盘
  const external = readFileSync(chapter, 'utf-8').replace(marker, '【外部改写】')
  writeFileSync(chapter, external)
  // ② 前端编辑 + ⌘S → 撞冲突
  const cm = page.locator('.cm-content')
  await cm.click()
  await page.keyboard.type('本地改动')
  await page.keyboard.press('ControlOrMeta+s') // R64-35（十二轮）：跨平台——非 mac 上 Meta+s 静默不触发（假红）
  await expect(page.locator('.conflict-btn').first()).toBeVisible({ timeout: 5_000 })
}

test('冲突 → 重载远端（丢本地取远端）', async ({ page }) => {
  attachPageErrorBaseline(page, 'conflict')
  await openChapter(page, '初入宗门')
  await provokeConflict(page, CHAPTER_1(), '林远踏入宗门')

  await page.locator('.conflict-btn').first().click()

  // cm 内容变远端（含【外部改写】，不含本地改动）
  const cm = page.locator('.cm-content')
  await expect(cm).toContainText('【外部改写】', { timeout: 5_000 })
  await expect(cm).not.toContainText('本地改动')
})

test('冲突 → 覆盖远端（丢远端写本地）', async ({ page }) => {
  attachPageErrorBaseline(page, 'conflict')
  await openChapter(page, '玉佩之秘')
  await provokeConflict(page, CHAPTER_2(), '玉佩突然爆发灵光')

  await page.locator('.conflict-btn.danger').click()
  // 重评-29（全库代码重评审 2026-09-05）：「覆盖」补 danger 二次确认（ui.ask→ConfirmPrompt，
  // 与清空对话/删章惯例对齐）——e2e 契约随行：点确认弹窗内 danger 确认键后才落 overwriteRemote
  await page.locator('.cp-modal .cp-actions .btn.danger').click()

  // 保存回正常态
  await expect(page.locator('.save-group .save-btn')).toContainText('已保存', { timeout: 5_000 })
  // 磁盘变本地内容（含本地改动，不含【外部改写】）
  const disk = readFileSync(CHAPTER_2(), 'utf-8')
  expect(disk).toContain('本地改动')
  expect(disk).not.toContain('【外部改写】')
})
