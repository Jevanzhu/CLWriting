/**
 * 机检 e2e（M12 块3 B3.3）：选章 → 右栏「机检」tab → 点机检 → 出报告。
 *
 * 机检无 AI 依赖（本地 runAllChecks），mock driver 下天然「断网可用」——
 * 与块1 三审（置灰）形成降级对照（三审 e2e 在切片3）。
 *
 * R76-10（二十四轮 F 域）：前置状态自建——此前「有分组才断条目」（if (groupCount > 0)）
 * 的条件性弱臂取决于 0001 现内容是否恰好产项（fixture 正文本来 clean，上游 spec 的
 * fm 改写会否翻出条目不可控），上游行为变化会把覆盖静默切到弱臂。本 spec 自建脏章：
 * 名册就位（fixture 无 设定/名册.md 时新专名检查整体跳过）+ 正文追加带引号的未登记
 * 专名「陌离子」→ 「新专名候选」黄项确定性产出；beforeAll 记录 / afterAll 恢复
 * （conflict.spec 同款契约，防跨 spec 状态泄漏）。
 */
import { test, expect } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachPageErrorBaseline } from './page-error-baseline.js'

// workDir 由 globalSetup 注入 env；须 lazy 读取——收集阶段（--list/单跑）不跑 globalSetup，顶层读会炸
const CHAPTER_1 = (): string =>
  join(process.env['CLWRITING_E2E_WORKDIR']!, '长篇', '长篇测试书', '写作', '正文', '0001-初入宗门.md')
const ROSTER = (): string =>
  join(process.env['CLWRITING_E2E_WORKDIR']!, '长篇', '长篇测试书', '设定', '名册.md')

let origChapter: string
let rosterExisted: boolean
let origRoster: string

test.beforeAll(() => {
  origChapter = readFileSync(CHAPTER_1(), 'utf-8')
  rosterExisted = existsSync(ROSTER())
  origRoster = rosterExisted ? readFileSync(ROSTER(), 'utf-8') : ''
  // 自建脏章：叙述行内带引号的 3 字未登记专名（无冒号引导/无嵌套引号/无句读，
  // 三条整行豁免均不触发）→ checkNewNames 确定性产 1 条黄项
  writeFileSync(CHAPTER_1(), origChapter + '\n石碑之上刻着「陌离子」三个古字，笔锋如刀。\n', 'utf-8')
  // 名册就位（fixture 缺席时该检查整体短路）；已登记名不产项——种子项唯一可控
  writeFileSync(ROSTER(), '林远\n赵长老\n', 'utf-8')
})

test.afterAll(() => {
  writeFileSync(CHAPTER_1(), origChapter, 'utf-8')
  if (rosterExisted) writeFileSync(ROSTER(), origRoster, 'utf-8')
  else writeFileSync(ROSTER(), '') // 空名册=检查静默跳过（等价缺席；e2e workDir 即弃，不追求 rm 语义）
})

test('机检：选章 → 机检 tab → 出报告（无 AI 依赖）', async ({ page }) => {
  attachPageErrorBaseline(page, 'check')
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText('初入宗门').first().click()
  // 编辑区渲染（章节已打开）。kk 观察：CI 慢速 runner 下冷启挂载可超默认 10s（首跑
  // 抖动实证），与 ai-review/analysis/conflict 同模式的编辑器挂载断言统一放宽到 20s
  await expect(page.locator('.cm-content')).toBeVisible({ timeout: 20_000 })

  // 切右栏「机检」tab（CheckSquare 图标，第3个 .right-tab：信息/审阅/机检/分析）
  await page.locator('.right-tabs .right-tab').nth(2).click()
  // CheckPanel 渲染 → 点「机检」按钮
  await page.locator('.check-run-btn').click()
  // 报告产出：R76-10 自建脏章 → 分组确定性可见（不再依赖「恰好有分组」的条件弱臂）
  await expect(page.locator('.check-panel .check-group').first()).toBeVisible({
    timeout: 15_000,
  })
  // 种子项锚定：新专名候选组产出未登记专名「陌离子」黄项（弱断言加强 P1-T5 的确定性版）。
  // R26-31（二十六轮）新增 lead-verb-invalid 黄项（账本节先于专名节产出）后，黄项组
  // DOM 首项不再恒为「陌离子」——契约是「组内产出该黄项」而非「居首」，改按内容定位
  // （hasText 靠黄项组内任一条目命中「新专名候选」字样，组定位口径不变）。
  const nameGroup = page.locator('.check-group', { hasText: '新专名候选' })
  await expect(nameGroup).toBeVisible()
  await expect(nameGroup.locator('.check-item', { hasText: '陌离子' }).first()).toContainText('陌离子')
})
