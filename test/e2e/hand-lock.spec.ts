/**
 * hand 锁 e2e（M11 E3.2 收尾）：CLI hand 占用某文档 → Studio 编辑保存撞 409 HAND_LOCKED
 * → 状态条「正在手写中」+ autosave 跳过；清锁后 manual 保存恢复。
 *
 * 触发：spec 进程写 .gui-active（source=hand + draftRelPath 命中当前章）→ 前端编辑 + ⌘S
 *      → 服务端 isHandDraftLocked 命中 → 409 HAND_LOCKED → 前端 handLocked 标记。
 * 不弹重载/覆盖层（hand 锁不可覆盖——会破坏外部手写）；autosave 跳过避免反复 409。
 */
import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'

function guiActivePath(): string {
  // bookRoot = <workDir>/长篇/长篇测试书；.gui-active 落 工作区/.gui-active
  return join(process.env['CLWRITING_E2E_WORKDIR']!, '长篇', '长篇测试书', '工作区', '.gui-active')
}

test('hand 锁：Studio 保存手写中文档 → 409 提示 + 清锁恢复', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText('初入宗门').first().click()
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible()

  // 造 hand 锁（.gui-active source=hand 命中该章 path）
  const guiPath = guiActivePath()
  mkdirSync(dirname(guiPath), { recursive: true })
  writeFileSync(
    guiPath,
    JSON.stringify({ pid: 99999, ts: Date.now(), source: 'hand', draftRelPath: '定稿/正文/0001-初入宗门.md' }),
  )

  // 编辑 + ⌘S → 409 HAND_LOCKED → 状态条显「手写中」（不弹重载/覆盖层）
  await cm.click()
  await page.keyboard.type('本地改动')
  await page.keyboard.press('Meta+s')
  await expect(page.locator('.save-group .save-btn')).toContainText('手写中', { timeout: 5_000 })
  // 不弹冲突出路层（hand 锁不可覆盖）
  await expect(page.locator('.conflict-btn')).toHaveCount(0)

  // 清锁 → manual 保存恢复成功
  rmSync(guiPath, { force: true })
  await page.keyboard.press('Meta+s')
  await expect(page.locator('.save-group .save-btn')).toContainText('已保存', { timeout: 5_000 })
})
