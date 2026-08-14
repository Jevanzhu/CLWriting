/// <reference lib="dom" />
// （主项目 tsc 的 lib 不含 dom；本 spec evaluate 回调裸用 document，按文件加载 dom lib，不收窄 e2e 13 spec 的类型覆盖）
/**
 * 改写 e2e（M12 块2）：选章 → 审阅 tab → 改写 → diff → 接受进 buffer → ⌘S 持久。
 *
 * 顺序敏感：选段（local）在前——不 accept 不落盘，文档保持干净；
 * 整章（whole）置末尾——accept + ⌘S 会把正文整章换成 mock writer 产出（W-P1-4 起
 * fm 由 mergeFm 保留，仅正文被替换），破坏 fixture 文档内容，故放最后避免污染后续 test。
 * mock writer 产出 = tryMockTool('submit_text') 契约文案（rewrite.ts runTask mock 快路）。
 */
import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// workDir 由 globalSetup 注入 env；须 lazy 读取——收集阶段（--list/单跑）不跑 globalSetup，顶层读会炸
function chapter1Path(): string {
  return join(process.env['CLWRITING_E2E_WORKDIR']!, '长篇', '长篇测试书', '写作', '正文', '0001-初入宗门.md')
}

// 整章 accept + ⌘S 会替换 0001 正文；fm 保留后该章仍是有效章节，账本检查
// （布线/悬念 的 0001 履历引文）会对后续所有章报红，污染 tree-issues 等下游 spec——
// afterAll 恢复原文（同 conflict.spec 的跨 spec 防泄漏约定）。
let orig1: string
test.beforeAll(() => {
  orig1 = readFileSync(chapter1Path(), 'utf-8')
})
test.afterAll(() => {
  writeFileSync(chapter1Path(), orig1, 'utf-8')
})

test('选段改写：选中段落 → 改写 → mode=选段', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText('初入宗门').first().click()
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible()

  // 编辑区选段：Playwright click 落在 .cm-content 空白区时光标会定位到文末，
  // Shift+ArrowRight 无字可选。改走 CM view 直接设 EditorState selection
  // （findFromDOM 等价路径 .cm-content.cmTile.root.view），选 body 前 3 字。
  // 本 test 核心是 selection 读取链路（editorGetSelection→getSelection→后端 local）。
  await page.evaluate(() => {
    const content = document.querySelector('.cm-content') as unknown as {
      cmTile?: { root?: { view?: { dispatch: (s: { selection: { anchor: number; head: number } }) => void; state: { doc: { length: number } } } } }
    }
    const view = content?.cmTile?.root?.view
    if (!view) return
    const end = Math.min(3, view.state.doc.length)
    view.dispatch({ selection: { anchor: 0, head: end } })
  })

  // 切审阅 tab（编辑区 blur 但 CM EditorState selection 保留）+ 改写指令 + 点改写
  await page.locator('.right-tabs .right-tab').nth(1).click()
  await page.locator('.rewrite-panel .rw-input').fill('更生动')
  await page.locator('.rewrite-panel .rw-run-btn').click()

  // selection 非空 → local 模式 → diff 渲染 + mode 标「选段」
  await expect(page.locator('.rewrite-panel .rw-diff')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.rewrite-panel .rw-mode')).toContainText('选段')
})

test('改写：选章 → 审阅 tab → 改写整章 → diff → 接受 → ⌘S 持久', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText('初入宗门').first().click()
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible()

  // 改写前正文不含 mock 标志
  await expect(cm).not.toContainText('mock 改写后的正文文本')

  // 切右栏「审阅」tab（第2个 .right-tab：信息/审阅/机检/分析）
  await page.locator('.right-tabs .right-tab').nth(1).click()

  // 输指令 + 触发改写整章
  await page.locator('.rewrite-panel .rw-input').fill('让开头更紧张')
  await page.locator('.rewrite-panel .rw-run-btn').click()

  // mock writer 产出 → diff 渲染（有 add 行）
  await expect(page.locator('.rewrite-panel .rw-diff')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.rewrite-panel .diff-add').first()).toBeVisible()

  // 接受 → rewritten 进编辑器 buffer
  await page.locator('.rewrite-panel .rw-accept').click()
  // diff 清空（result=null）
  await expect(page.locator('.rewrite-panel .rw-diff')).toHaveCount(0)
  // 编辑器 buffer 已更新为 mock 产出（submit_text 契约文案）
  await expect(cm).toContainText('mock 改写后的正文文本')

  // ⌘S 保存 → 落盘
  await page.keyboard.press('Meta+s')
  await expect(page.locator('.save-group .save-btn')).toContainText('已保存', { timeout: 5_000 })

  // 重载验证持久（patch→⌘S 已落盘，重选章正文仍是 mock 产出）
  // reload 留在书内（/book/...），直接重选章——无需再点书卡（原 getByText 命中的是面包屑）
  await page.reload()
  await page.getByText('初入宗门').first().click()
  await expect(page.locator('.cm-content')).toContainText('mock 改写后的正文文本')
})
