/**
 * T1.2 写作保存（M11 E1）：左栏选章 → .cm-content 键入 → ⌘S → 保存成功 + 全书字数增加。
 *
 * 关键回路（细案 §6 风险点）：CodeMirror 6 输入 + 乐观锁保存 + tree 字数局部更新。
 * - 章节在「写作」组默认展开层（groupTree：定稿/正文 章节直挂写作组）
 * - save 成功 → doc.ts 调 tree.updateWordCount → StatusBar 全书字数重算
 * - manual save 成功 → EditorView save-state 显「已保存」
 */
import { test, expect } from '@playwright/test'

/** 从状态栏「全书 N · 今日 +M」提取全书字数。 */
function parseTotalWords(s: string | null): number {
  const m = (s ?? '').match(/全书\s*([\d,]+)/)
  return m ? Number((m[1] ?? '').replace(/,/g, '')) : 0
}

test('选章编辑 → ⌘S 保存 → 字数增加', async ({ page }) => {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await expect(page.locator('.ws-shell')).toBeVisible()

  // 选章：左栏章节树渲染后点「初入宗门」（substring 命中 node.name）
  await expect(page.getByText('初入宗门').first()).toBeVisible()
  await page.getByText('初入宗门').first().click()

  // 编辑区渲染 + 记保存前字数
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible()
  const words = page.locator('.status-words')
  await expect(words).toBeVisible()
  const before = parseTotalWords(await words.textContent())

  // 键入追加 + ⌘S 保存
  await cm.click()
  await page.keyboard.type('e2e 追加内容')
  await page.keyboard.press('Meta+s')

  // 保存成功反馈（save-state 持久显「已保存」，比 toast 稳）
  await expect(page.locator('.save-state')).toContainText('已保存', { timeout: 5_000 })
  // 全书字数增加（updateWordCount 已局部刷新）
  const after = parseTotalWords(await words.textContent())
  expect(after).toBeGreaterThan(before)
})
