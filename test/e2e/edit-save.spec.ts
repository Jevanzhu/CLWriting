/**
 * T1.2 写作保存（M11 E1）：左栏选章 → .cm-content 键入 → ⌘S → 保存成功 + 全书字数增加。
 *
 * 关键回路（细案 §6 风险点）：CodeMirror 6 输入 + 乐观锁保存 + tree 字数局部更新。
 * - 章节在「写作」组默认展开层（groupTree：写作/正文 章节直挂写作组）
 * - save 成功 → doc.ts 调 tree.updateWordCount → StatusBar 全书字数重算
 * - manual save 成功 → EditorView save-state 显「已保存」
 */
import { test, expect } from '@playwright/test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 从状态栏「全书 N · 今日 +M」提取全书字数。 */
function parseTotalWords(s: string | null): number {
  const m = (s ?? '').match(/全书\s*([\d,]+)/)
  return m ? Number((m[1] ?? '').replace(/,/g, '')) : 0
}

// 二轮复审（批 5）：收尾恢复 0001 原文——e2e 共享 globalSetup 的单一 workDir，
// 残留的追加正文会被后续 spec（字数/机检/收割断言）读到，spec 间产生隐式顺序依赖。
// R73-70（F-3）：正文之外，保存链路还会写两处「派生状态」，此前不恢复导致下游
// （usage-card 等）只能写弱断言——
// ① 项目/字数日记.jsonl：save settled 记 {date,delta} 条目（readTodayDelta 按日累加）
// ② .cache/index.db：树红点 A1 缓存（树 API 访问时 rebuild，含追加后的正文指纹）
// 恢复口径：delta 行滤除（前序 spec 的 baseline「今日基线」条目保留）；.cache 整目录
// 移除（缓存是纯加速，缺席自动 rebuild，与 fixture 初态一致）。防御性：三步各自
// 独立 try/catch，任一恢复失败不阻断（workDir 每次运行重建，最坏是本轮下游受影响）。
test.afterAll(() => {
  const workDir = process.env['CLWRITING_E2E_WORKDIR']
  if (!workDir) return
  const bookRoot = join(workDir, '长篇', '长篇测试书')
  try {
    const fp = join(bookRoot, '写作', '正文', '0001-初入宗门.md')
    const src = readFileSync(fp, 'utf8')
    if (src.includes('e2e 追加内容')) writeFileSync(fp, src.replace('e2e 追加内容', ''), 'utf8')
  } catch {
    /* 恢复失败不阻断（workDir 每次运行重建，最坏情形是本轮后续 spec 受影响） */
  }
  // R73-70①：字数日记只滤 delta 条目——baseline 条目（他 spec 的「今日基线」）保留
  try {
    const diary = join(bookRoot, '项目', '字数日记.jsonl')
    if (existsSync(diary)) {
      const kept = readFileSync(diary, 'utf8')
        .split('\n')
        .filter((line) => {
          if (!line.trim()) return false
          try {
            const rec = JSON.parse(line) as { delta?: unknown }
            return rec.delta === undefined // delta 条目是本 spec 保存动作新增，滤除
          } catch {
            return true // 坏行非本 spec 产物，保守保留
          }
        })
      if (kept.length === 0) rmSync(diary, { force: true })
      else writeFileSync(diary, kept.join('\n') + '\n', 'utf8')
    }
  } catch {
    /* 同上：恢复失败不阻断 */
  }
  // R73-70②：树缓存整目录移除——collectTreeIssues 对缺席缓存自动 rebuild（纯加速语义）
  try {
    rmSync(join(bookRoot, '.cache'), { recursive: true, force: true })
  } catch {
    /* 同上：恢复失败不阻断 */
  }
})

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
  await page.keyboard.press('ControlOrMeta+s') // R64-35（十二轮）：跨平台——非 mac 上 Meta+s 静默不触发（假红）

  // 保存成功反馈（save-state 持久显「已保存」，比 toast 稳）
  await expect(page.locator('.save-group .save-btn')).toContainText('已保存', { timeout: 5_000 })
  // 全书字数增加（updateWordCount 已局部刷新）
  const after = parseTotalWords(await words.textContent())
  expect(after).toBeGreaterThan(before)
})
