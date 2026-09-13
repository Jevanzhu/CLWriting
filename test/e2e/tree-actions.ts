/**
 * 章节树操作 e2e 共享动作（复审-0913-结构 P2-3 三方收编：原 tree-ops /
 * structure-ops / structure-volume-move 各持一份逐字相同的本组 helper）。
 * 版本以 structure-ops / structure-volume-move 两新件为基（函数体逐字节同）；
 * clickSubmenuItem 放宽为 name: string | RegExp（volume-move 版超集，两卷名互为
 * 前缀需收窄时传锚定 regex，string 子串匹配用法兼容 tree-ops）。扁平模块
 * （page-error-baseline.ts 先例），import 走 './tree-actions.js'。
 */
import { expect, type Page } from '@playwright/test'

/** 进入长篇测试书工作台，确保章节树面板就绪 */
export async function gotoBook(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await expect(page.locator('.ws-shell')).toBeVisible()
  // 确保回到章节树面板（上个 test 可能切走，leftPanel 持久化）
  await page.locator('.rbtn[data-tip*="章节树"]').click()
  await expect(page.locator('.tree-item').first()).toBeVisible()
}

/** 右键某树项（按 label 文本匹配 .tree-item） */
export async function ctxOn(page: Page, label: string): Promise<void> {
  await page.locator('.tree-item').filter({ hasText: label }).first().click({ button: 'right' })
}

/** hover 子菜单父项，等子菜单出现 */
export async function hoverSubmenu(page: Page, parentLabel: string): Promise<void> {
  await page.locator('.cm-menu .cm-has-sub').filter({ hasText: parentLabel }).hover()
  await expect(page.locator('.cm-submenu')).toBeVisible()
}

/** 点子菜单里的某项（name 容 string/regex——两卷名互为前缀，收窄时用锚定 regex） */
export async function clickSubmenuItem(page: Page, name: string | RegExp): Promise<void> {
  await page.locator('.cm-submenu').getByRole('menuitem', { name }).click()
}

/**
 * 右键「写作」组新建正文章。seed 预填「NNNN-未命名」——保留章号前缀提交（无前缀
 * 文件名对 nextChapterNo 不可见，连建两章会拿到重号 fm 章号，合并干跑按「跨卷重号
 * 章」400 拒收）；前缀从 seed 现读不自 hardcode。
 * 注意须在建卷**之前**调用：有卷时「新建章节」落 lastVolume（onMenuSelect
 * new-chapter-root），要落正文根的场景必须先建章后建卷。
 */
export async function createChapter(page: Page, title: string): Promise<void> {
  await ctxOn(page, '写作')
  await page.locator('.cm-menu').getByRole('menuitem', { name: '新建章节' }).click()
  const input = page.locator('.inline-input')
  await expect(input).toBeVisible()
  const prefix = (await input.inputValue()).replace(/未命名$/, '')
  await input.fill(`${prefix}${title}`)
  await page.keyboard.press('Enter')
  await expect(page.locator('.tree-list')).toContainText(title)
}

/** 软删某章（右键 → 删除 → .cp-modal 确认）——收尾净零用，进回收站可还原 */
export async function deleteChapter(page: Page, title: string): Promise<void> {
  await ctxOn(page, title)
  await page.locator('.cm-menu').getByRole('menuitem', { name: '删除' }).click()
  await page.locator('.cp-modal').getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.locator('.tree-list')).not.toContainText(title)
}
