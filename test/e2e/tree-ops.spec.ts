/**
 * T1.4 语义树操作（M11 E1）：新建章 / 重命名 / 移动 / 软删 / 回收站还原。
 *
 * 拆 3 个独立 test（串行共享 workDir，各用不同章避免磁盘状态耦合）：
 * - 新建章 + 重命名（新建的章贯穿）
 * - 软删 fixture 章 → 回收站还原
 * - 建卷 + 移动章到卷
 *
 * 右键菜单：.tree-item click({button:'right'}) → .cm-menu → 子菜单 hover .cm-has-sub
 * 展开 .cm-submenu → 点子项；inline 新建/重命名输入 .inline-input + Enter。
 * 删除弹 ConfirmPrompt（通用确认框 .cp-modal），测试里点确认钮。
 */
import { test, expect, type Page } from '@playwright/test'

async function gotoBook(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await expect(page.locator('.ws-shell')).toBeVisible()
}

/** 右键某树项（按 label 文本匹配 .tree-item） */
async function ctxOn(page: Page, label: string): Promise<void> {
  await page.locator('.tree-item').filter({ hasText: label }).first().click({ button: 'right' })
}

/** hover 子菜单父项，等子菜单出现 */
async function hoverSubmenu(page: Page, parentLabel: string): Promise<void> {
  await page.locator('.cm-menu .cm-has-sub').filter({ hasText: parentLabel }).hover()
  await expect(page.locator('.cm-submenu')).toBeVisible()
}

/** 点子菜单里的某项 */
async function clickSubmenuItem(page: Page, name: string): Promise<void> {
  await page.locator('.cm-submenu').getByRole('button', { name }).click()
}

/** inline 输入提交（新建/重命名共用） */
async function commitInline(page: Page, value: string): Promise<void> {
  await expect(page.locator('.inline-input')).toBeVisible()
  await page.locator('.inline-input').fill(value)
  await page.keyboard.press('Enter')
}

test('新建章 + 重命名', async ({ page }) => {
  await gotoBook(page)
  // 新建章：右键「写作」组 → 新建 → 章节
  await ctxOn(page, '写作')
  await hoverSubmenu(page, '新建')
  await clickSubmenuItem(page, '章节')
  await commitInline(page, 'e2e新建章')
  await expect(page.locator('.tree-list')).toContainText('e2e新建章')
  // 重命名
  await ctxOn(page, 'e2e新建章')
  await page.locator('.cm-menu').getByRole('button', { name: '重命名' }).click()
  await commitInline(page, 'e2e改名章')
  await expect(page.locator('.tree-list')).toContainText('e2e改名章')
  await expect(page.locator('.tree-list')).not.toContainText('e2e新建章')
})

test('软删 → 回收站还原', async ({ page }) => {
  await gotoBook(page)
  await expect(page.locator('.tree-list')).toContainText('玉佩之秘')
  // 软删
  await ctxOn(page, '玉佩之秘')
  await page.locator('.cm-menu').getByRole('button', { name: '删除' }).click()
  // ConfirmPrompt 确认（替代原 window.confirm 自动 accept）
  await page.locator('.cp-modal').getByRole('button', { name: '删除' }).click()
  await expect(page.locator('.tree-list')).not.toContainText('玉佩之秘')
  // 回收站还原
  await page.locator('.left-tab[title="回收站"]').click()
  await expect(page.locator('.trash-panel')).toContainText('玉佩之秘')
  await page.getByRole('button', { name: '恢复' }).click()
  // 切回树，章回来
  await page.locator('.left-tab[title="章节树"]').click()
  await expect(page.locator('.tree-list')).toContainText('玉佩之秘')
})

test('建卷 → 移动章到卷', async ({ page }) => {
  await gotoBook(page)
  // 建卷
  await ctxOn(page, '写作')
  await hoverSubmenu(page, '新建')
  await clickSubmenuItem(page, '卷')
  await commitInline(page, 'e2e测试卷')
  await expect(page.locator('.tree-list')).toContainText('e2e测试卷')
  // 移动「初入宗门」到 e2e测试卷
  await ctxOn(page, '初入宗门')
  await hoverSubmenu(page, '移动到')
  await clickSubmenuItem(page, 'e2e测试卷')
  // 展开卷 → 章在卷下
  await page.locator('.tree-item').filter({ hasText: 'e2e测试卷' }).first().click()
  await expect(page.locator('.tree-list')).toContainText('初入宗门')
})

test('复制章 → 副本入树 + 内容同源', async ({ page }) => {
  await gotoBook(page)
  // 用「玉佩之秘」：test2 还原后稳定在正文根、test3 未移动（避免 fixture 状态耦合）
  await expect(page.locator('.tree-list')).toContainText('玉佩之秘')
  await ctxOn(page, '玉佩之秘')
  await page.locator('.cm-menu').getByRole('button', { name: '创建副本' }).click()
  // 副本入树（源标题 +「副本」后缀，章号前端算）
  await expect(page.locator('.tree-list')).toContainText('玉佩之秘 副本')
  // 点开副本 → 编辑区内容同源（源正文特征词「林远」，证明是复制非空文件）
  await page.locator('.tree-item').filter({ hasText: '玉佩之秘 副本' }).first().click()
  await expect(page.locator('.cm-content')).toContainText('林远')
})
