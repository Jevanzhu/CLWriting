/**
 * 阶段 24 章节结构操作 e2e：并入上一章 / 撤销并入 / 光标处拆分（S3+S4 前端动线）。
 *
 * 拆 3 个独立 test（串行共享 workDir，全部用 e2e 前缀新章，不碰 fixture 章）：
 * - 并入上一章：建相邻两章 → 右键源章 → 干跑确认（.cp-modal）→ 源章移出正文（软删进回收站）
 * - 撤销并入：右键目标章 → 确认 → 目标回滚 + 源章从回收站还原（净零恢复）
 * - 光标处拆分：建章输入三段正文 → 光标落在中段行 → 右键拆分 → SplitChapterDialog
 *   标题必填（空标题禁用）→ 确认后原章截断、新章入树并自动打开
 *
 * 与 tree-ops 的关键差异——**收尾净零**：本 spec 按字典序插在 short-full-flow 与
 * switch-book 之间，而后序 switch-book 对长篇书总览断言章节 KPI /^4/（正文目录章数），
 * 本 spec 建的 4 个 e2e 章若留在正文，KPI 变 8 必连坐红——故 test2/test3 各自收尾把
 * 本 test 建的章软删（进回收站，tree-ops 后续回收站断言只按行过滤不受扰），正文目录
 * 回到 fixture 4 章净零态。tree-ops 排在 switch-book 之后才可留态，排序契约下不可比。
 *
 * 选择器口径（与 tree-ops 同源，helper 已收编至 ./tree-actions.js——复审-0913-结构
 * P2-3）：右键树项 .tree-item → .cm-menu menuitem；合并/撤销走 ui.ask 通用确认框
 * .cp-modal；拆分是独立弹窗 teleport 到 body（.split-mask / .split-dialog，
 * aria-label="在光标处拆分"），标题必填 input + 无标题禁用确认钮。
 */
import { test, expect } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'
import { gotoBook, ctxOn, createChapter, deleteChapter } from './tree-actions.js'

test('并入上一章：干跑确认 → 源章移出正文', async ({ page }) => {
  attachPageErrorBaseline(page, 'structure-ops')
  await gotoBook(page)
  // 先建目标再建源：显示序相邻（新章按序号追加，源章的「上一章」即目标）
  await createChapter(page, 'e2e合并目标')
  await createChapter(page, 'e2e合并源')
  // 右键源章 → 「并入上一章（<前一章名>）」（树名带章号前缀，regex 容编号）
  await ctxOn(page, 'e2e合并源')
  await page
    .locator('.cm-menu')
    .getByRole('menuitem', { name: /并入上一章（.*e2e合并目标）/ })
    .click()
  // 干跑确认：ui.ask → .cp-modal（标题「并入上一章」，多行预演 message），确认钮 并入
  const modal = page.locator('.cp-modal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.cp-title')).toHaveText('并入上一章')
  await modal.getByRole('button', { name: '并入', exact: true }).click()
  // 源章软删（回收站），目标仍在正文——正文目录章数回到净零前的 -1
  await expect(page.locator('.tree-list')).not.toContainText('e2e合并源')
  await expect(page.locator('.tree-list')).toContainText('e2e合并目标')
})

test('撤销并入：目标回滚 + 源章还原（净零恢复）', async ({ page }) => {
  attachPageErrorBaseline(page, 'structure-ops')
  await gotoBook(page)
  // 上个 test 的合并留态：目标在正文、源在回收站
  await expect(page.locator('.tree-list')).toContainText('e2e合并目标')
  await ctxOn(page, 'e2e合并目标')
  await page.locator('.cm-menu').getByRole('menuitem', { name: '撤销并入' }).click()
  const modal = page.locator('.cp-modal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.cp-title')).toHaveText('撤销并入')
  await modal.getByRole('button', { name: '撤销并入', exact: true }).click()
  // 源章从回收站还原为独立章节（目标章内容回滚到合并前）
  await expect(page.locator('.tree-list')).toContainText('e2e合并源')
  await expect(page.locator('.tree-list')).toContainText('e2e合并目标')
  // 收尾净零（见文件头）：本 test 建的合并对软删，正文目录回到 fixture 4 章，
  // 否则后序 switch-book 总览章节 KPI /^4/ 连坐红
  await deleteChapter(page, 'e2e合并目标')
  await deleteChapter(page, 'e2e合并源')
})

test('光标处拆分：标题必填 → 新章入树并自动打开', async ({ page }) => {
  attachPageErrorBaseline(page, 'structure-ops')
  await gotoBook(page)
  await createChapter(page, 'e2e拆分章')
  // 点树项打开 → 编辑器就位（新章模板正文为空，fm 已剥离）
  await page.locator('.tree-item').filter({ hasText: 'e2e拆分章' }).first().click()
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible()
  // 点入编辑器输入三段正文（insertText 免 IME，autosave 防抖由拆分动线 flushUnsaved 兜住）
  await cm.click()
  await page.keyboard.insertText('拆分头段文本。\n拆分中段文本。\n拆分尾段文本。')
  await expect(cm).toContainText('拆分尾段文本')
  // 光标落在中段行（行内点击，光标行内/行尾皆可——拆分点只需在正文内且尾段非空）
  await page.locator('.cm-line', { hasText: '拆分中段文本' }).click()
  // 右键该章树项 → 「在光标处拆分…」（仅当前打开章显示——上文点树项已打开）
  await ctxOn(page, 'e2e拆分章')
  await page.locator('.cm-menu').getByRole('menuitem', { name: '在光标处拆分' }).click()
  // 独立弹窗（非 ui.ask）：info 行含 tail 预览；标题空 → 拆分钮禁用
  const dialog = page.locator('.split-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.split-info')).toContainText('拆分尾段文本')
  const splitBtn = dialog.getByRole('button', { name: '拆分', exact: true })
  await expect(splitBtn).toBeDisabled()
  // 填新章标题 → 拆分钮解禁 → 确认 → 弹窗关闭
  await dialog.locator('input[placeholder="拆分出新章的标题（必填）"]').fill('e2e拆分新章')
  await expect(splitBtn).toBeEnabled()
  await splitBtn.click()
  await expect(page.locator('.split-mask')).toHaveCount(0)
  // 新章入树（显示序插原章之后）且编辑器自动切到新章：内容只含尾段、不含头段
  await expect(page.locator('.tree-list')).toContainText('e2e拆分新章')
  await expect(cm).toContainText('拆分尾段文本')
  await expect(cm).not.toContainText('拆分头段文本')
  // 收尾净零（见文件头）：软删本 test 两章，保后序 switch-book 章节 KPI /^4/
  await deleteChapter(page, 'e2e拆分新章')
  await deleteChapter(page, 'e2e拆分章')
})
