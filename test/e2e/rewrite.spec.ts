/// <reference lib="dom" />
// （主项目 tsc 的 lib 不含 dom；本 spec evaluate 回调裸用 document，按文件加载 dom lib，不收窄 e2e 13 spec 的类型覆盖）
/**
 * 改写 e2e（M12 块2）：选章 → 审阅 tab → 改写 → diff → 接受进 buffer → ⌘S 持久。
 *
 * 顺序敏感：选段（local）在前——不 accept 不落盘，文档保持干净；
 * 整章（whole）置末尾——accept + ⌘S 会把正文（含 fm）整章换成 mock writer 产出（无 fm），
 * 破坏 fixture 文档结构，故放最后避免污染后续 test。
 * mock driver writer role 返 `【mock · writer】…模拟产出…`。
 */
import { test, expect } from '@playwright/test'

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
  await page.locator('.right-tab').nth(1).click()
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
  await expect(cm).not.toContainText('模拟产出')

  // 切右栏「审阅」tab（第2个 .right-tab：信息/审阅/机检/分析）
  await page.locator('.right-tab').nth(1).click()

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
  // 编辑器 buffer 已更新为 mock 产出
  await expect(cm).toContainText('模拟产出')

  // ⌘S 保存 → 落盘
  await page.keyboard.press('Meta+s')
  await expect(page.locator('.save-state')).toContainText('已保存', { timeout: 5_000 })

  // 重载验证持久（patch→⌘S 已落盘，重选章正文仍是 mock 产出）
  // reload 留在书内（/book/...），直接重选章——无需再点书卡（原 getByText 命中的是面包屑）
  await page.reload()
  await page.getByText('初入宗门').first().click()
  await expect(page.locator('.cm-content')).toContainText('模拟产出')
})
