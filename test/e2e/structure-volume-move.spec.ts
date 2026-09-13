/**
 * 阶段 24 批 C 卷重组验收项 e2e：跨卷移动 × 结构操作体系（并入上一章 / 撤销并入）。
 *
 * 卷重组验收（批 1 降级项，见 章节结构操作-执行方案-2026-09-04 §批 C「跨卷 move 全链
 * 核对 + e2e 1 spec」）的 e2e 面：跨卷移动后树显示序重排 + 「并入上一章」按显示序
 * 跨卷找前章 + 撤销按原路径还原。3 个独立 test（串行共享 workDir，test2 接 test1
 * 留态），全部 e2e 前缀新章、不碰 fixture 章；收尾两章软删净零，后序 switch-book
 * 总览章节 KPI /^4/ 不连坐。
 *
 * 与任务预设的四处实测偏离（实抓如实记档，未改产品码，语义取舍留作者拍板）：
 * ① 显示序实测 = 卷优先分组 DFS，非「fm 序跨卷全局排」：服务端 sortTreeByOrder 只
 *   重排同目录内的章文件（fm 序 ?? 章号），卷目录位置由 compareNode 目录优先钉死
 *   ——卷内章恒渲染在散章之前。乙（章号 6）移入卷后 DOM 序在甲（章号 5）**上方**，
 *   与任务预设「甲仍在乙的显示序前方」相反（buildTree 实探 + tree-menu-structure
 *   单测「children 顺序即显示序」同源）。本 spec 按实测钉（spec 须绿）。
 * ② 跨卷并入需两卷构型：散章的显示序前章永远还是散章（卷整体在前），单卷 + 散章
 *   造不出跨卷并入。test2 增建卷「e2e重组」收甲（localeCompare 前缀序必排
 *   「e2e重组卷」之前），乙的显示序前章才是跨卷的甲——并入方向与任务预设一致
 *   （乙并入甲），撤销后乙按原路径还原回「e2e重组卷」卷内。
 * ③ 建卷即建首章：onCreateCommit volume 分支自动在卷内建「NNNN-未命名.md」（空文件
 *   无 fm）并打开（任务预设卷为空壳未计此行为）。种子章章号最大又占卷内 DFS 位，
 *   会顶掉甲/乙成为「并入上一章」的显示序前章（首跑实抓：test2 右键乙菜单显示
 *   「并入上一章（0008-未命名）」、预设菜单项缺失超时红）——createVolume 内展开卷
 *   清删种子章交付空卷；两枚种子章随收尾一并净零（软删进回收站）。
 * ④ 撤销并入的回收站反查歧义（产品缺陷面，test2 首跑实抓）：e2e 服务端无
 *   userDataPath → 事件定位恒 null，undo 走盘面兜底 locateMergeByDisk——按
 *   max(并入) 章号反查回收站**首个**同章号条目。structure-ops 的软删残留（0005/0006
 *   ×2）与本章同章号，撤销误还原了「0006-e2e合并源」（连坐 switch-book KPI 5章红）。
 *   test1 开场经 trash REST 清空回收站去歧义（REST 因由见 purgeAllTrash 注）——清的
 *   是共享 workDir 既有条目，后序 tree-ops 回收站断言按行过滤不受扰。缺陷本体
 *   （同章号旧条目被误认领）留作者拍板是否收口。
 *
 * 两卷均留态（收尾不删）：卷目录无 UI 删除入口（卷右键菜单只有新建章节），tree-ops
 * 「e2e测试卷」先例同款；卷不计章节 KPI，后序 tree-ops test1 新建章落 lastVolume
 * 语义不受扰（startCreate 自动展开落点卷，其断言不钉位置）。
 *
 * 选择器口径与 structure-ops/tree-ops 同源：右键 .tree-item → .cm-menu menuitem；
 * 「移动到」子菜单 hover .cm-has-sub 展开 .cm-submenu；合并/撤销走 ui.ask 通用确认
 * 框 .cp-modal（确认钮 并入 / 撤销并入，exact: true）。树名带章号前缀（如
 * 「0006-e2e卷移乙」），菜单项 label 用 regex 容前缀。卷展开态不假设（书级 prefs
 * 持久化时序不定）：按 aria-expanded 判后点——点行是 toggle，盲点会把已展开的卷
 * 折叠；卷名互为前缀（e2e重组 ⊂ e2e重组卷），行定位用锚定 regex。新建章 seed
 * 「NNNN-」前缀保留提交（无前缀文件名对 nextChapterNo 不可见，连建两章 fm 章号
 * 重号——structure-ops 同款已知行为约束）。
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'

async function gotoBook(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await expect(page.locator('.ws-shell')).toBeVisible()
  // 确保回到章节树面板（上个 test 可能切走，leftPanel 持久化）
  await page.locator('.rbtn[data-tip*="章节树"]').click()
  await expect(page.locator('.tree-item').first()).toBeVisible()
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

/** 点子菜单里的某项（name 容 string/regex——两卷名互为前缀，收窄时用锚定 regex） */
async function clickSubmenuItem(page: Page, name: string | RegExp): Promise<void> {
  await page.locator('.cm-submenu').getByRole('menuitem', { name }).click()
}

/** 软删某章（右键 → 删除 → .cp-modal 确认）——收尾净零/清种子章用，进回收站 */
async function deleteChapter(page: Page, title: string): Promise<void> {
  await ctxOn(page, title)
  await page.locator('.cm-menu').getByRole('menuitem', { name: '删除' }).click()
  await page.locator('.cp-modal').getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.locator('.tree-list')).not.toContainText(title)
}

/**
 * 右键「写作」组新建正文卷（卷 seed 为空直接填名）。收尾断言锚定卷行（目录行恒有
 * aria-expanded；inline 输入行/提示行没有）可见——卷行出现 = 建卷 reload 已落定，
 * 后续「移动到」子菜单从 grouped 现算，等不到 reload 会缺目标项。
 *
 * 建卷即建首章（实抓：onCreateCommit volume 分支自动建「NNNN-未命名.md」并打开）——
 * 随后展开卷清删种子章，交付**空卷**：种子章章号最大又排在卷内 DFS 位，会顶掉甲/
 * 乙成为「并入上一章」的显示序前章（首跑实抓致 test2 菜单项缺失）。空目录仍在盘
 * （trash 只摘文件不剪父目录，scanDir readdir 直列空目录），卷节点不消失。
 */
async function createVolume(page: Page, name: string): Promise<void> {
  await ctxOn(page, '写作')
  await page.locator('.cm-menu').getByRole('menuitem', { name: '新建卷' }).click()
  const input = page.locator('.inline-input')
  await expect(input).toBeVisible()
  await input.fill(name)
  await page.keyboard.press('Enter')
  await expect(volumeRow(page, name)).toBeVisible()
  await expandVolume(page, name)
  await deleteChapter(page, '未命名')
}

/**
 * 右键「写作」组新建正文章。seed 预填「NNNN-未命名」——保留章号前缀提交（无前缀
 * 文件名对 nextChapterNo 不可见，连建两章 fm 章号重号，合并干跑按跨卷重号 400 拒收）；
 * 前缀从 seed 现读不 hardcode。注意须在建卷**之前**调用：有卷时「新建章节」落
 * lastVolume（onMenuSelect new-chapter-root），本 spec 两章都要落正文根。
 */
async function createChapter(page: Page, title: string): Promise<void> {
  await ctxOn(page, '写作')
  await page.locator('.cm-menu').getByRole('menuitem', { name: '新建章节' }).click()
  const input = page.locator('.inline-input')
  await expect(input).toBeVisible()
  const prefix = (await input.inputValue()).replace(/未命名$/, '')
  await input.fill(`${prefix}${title}`)
  await page.keyboard.press('Enter')
  await expect(page.locator('.tree-list')).toContainText(title)
}

/** 卷目录行（锚定 regex——e2e重组 ⊂ e2e重组卷，substring hasText 分不开两行） */
function volumeRow(page: Page, name: string): Locator {
  return page.locator('.tree-item[aria-expanded]').filter({ hasText: new RegExp(`^${name}$`) })
}

/**
 * 展开某卷（已展开则不动）：点行是 toggle，盲点会把已展开的卷折叠——按
 * aria-expanded 判后点。展开态跨 test 不假设（书级 prefs 500ms 防抖落盘时序不定，
 * 新 page 的回填与否都接得住）。
 */
async function expandVolume(page: Page, name: string): Promise<void> {
  const row = volumeRow(page, name)
  await expect(row).toBeVisible()
  if ((await row.getAttribute('aria-expanded')) === 'false') await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
}

/** 卷内章行（aria-level=4：写作1/正文2/卷3/卷内章4；正文根散章 = 3）——「在卷下」钉层级而非裸 containsText */
function chapterUnderVolume(page: Page, title: string): Locator {
  return page.locator('.tree-item[aria-level="4"]').filter({ hasText: title })
}

/**
 * 清空长篇书回收站（trash REST 直发，setup 性质不走面板动线）。去歧义用：撤销并入在
 * e2e（无 userDataPath → 事件定位 null）走盘面兜底 locateMergeByDisk，按 max(并入)
 * 章号反查回收站首个同章号条目——structure-ops 的软删残留（0005/0006 ×2）不摘除会
 * 抢被本章撤销的源章（test2 首跑实抓，见头注④）。REST 而非面板点击：回收站面板
 * 「加载中」与「为空」同渲染空态，DOM 判空会提前断循环致清除 no-op（二跑实抓）。
 * 认证：/api/* 须 x-studio-token（三跑实抓：裸 page.request 403，且响应无 entries 键
 * 令清零断言空过）——先 GET /api/boot（豁免通道）领 token 再挂头。末尾复读断言清零。
 */
async function purgeAllTrash(page: Page): Promise<void> {
  const book = encodeURIComponent('长篇测试书')
  const boot = (await (await page.request.get('/api/boot')).json()) as { token?: string }
  const headers = { 'x-studio-token': boot.token ?? '' }
  const list = await page.request.get(`/api/books/${book}/trash`, { headers })
  const { entries } = (await list.json()) as { entries?: Array<{ id: string }> }
  for (const entry of entries ?? []) {
    await page.request.delete(`/api/books/${book}/trash/${encodeURIComponent(entry.id)}`, { headers })
  }
  const after = await (await page.request.get(`/api/books/${book}/trash`, { headers })).json()
  expect(((after as { entries?: unknown[] }).entries ?? []).length).toBe(0)
}

test('跨卷移动：乙移入卷 + 显示序随树重排（卷优先分组实测序）', async ({ page }) => {
  attachPageErrorBaseline(page, 'structure-volume-move')
  await gotoBook(page)
  // 清空共享 workDir 既有回收站（头注④）——为本章 test2 的撤销并入盘面定位去歧义
  await purgeAllTrash(page)
  // 先建两章再建卷（顺序不可倒——有卷时新建章节落 lastVolume），显示序相邻（甲 0005 → 乙 0006）
  await createChapter(page, 'e2e卷移甲')
  await createChapter(page, 'e2e卷移乙')
  await createVolume(page, 'e2e重组卷')
  // 乙移入卷：右键 → 移动到… → e2e重组卷（此时唯一卷，子菜单单项；正文根因源父目录被排除）
  await ctxOn(page, 'e2e卷移乙')
  await hoverSubmenu(page, '移动到')
  await clickSubmenuItem(page, 'e2e重组卷')
  // 展开卷 → 乙在卷下（aria-level=4 钉层级；跨卷 move 走既有 move 管线不改 fm，章号仍 6）
  await expandVolume(page, 'e2e重组卷')
  await expect(chapterUnderVolume(page, 'e2e卷移乙')).toBeVisible()
  // 显示序实测钉（头注①）：卷优先分组 DFS——卷内章渲染在散章之前，乙（卷内）在
  // 甲（散章）上方。任务预设「甲仍在乙前方」与实测相反；未改产品码按实测钉，
  // 「显示序是否应跨卷按 fm 序全局排」留作者拍板。
  const domGap = await page
    .locator('.tree-list')
    .evaluate((el) => {
      // Array.from 非 spread：tsconfig lib 无 DOM.Iterable，NodeListOf 不可展开
      const texts = Array.from(el.querySelectorAll('.tree-item')).map((n) => n.textContent ?? '')
      return texts.findIndex((t) => t.includes('e2e卷移乙')) - texts.findIndex((t) => t.includes('e2e卷移甲'))
    })
  expect(domGap).toBeLessThan(0)
})

test('跨卷并入：显示序前章跨卷命中（乙并入甲）+ 撤销还原原卷路径', async ({ page }) => {
  attachPageErrorBaseline(page, 'structure-volume-move')
  await gotoBook(page)
  // test1 留态（卷展开态不假设，先展开再验）：乙在 e2e重组卷 卷内、甲在正文根
  await expandVolume(page, 'e2e重组卷')
  await expect(chapterUnderVolume(page, 'e2e卷移乙')).toBeVisible()
  await expect(page.locator('.tree-list')).toContainText('e2e卷移甲')
  // 建第二卷「e2e重组」收甲（头注②）：前缀序必排「e2e重组卷」之前，两卷 DFS 序 =
  // [甲, 乙, …散章]，乙的显示序前章才是跨卷的甲（散章的前章恒是散章，单卷造不出跨卷并入）
  await createVolume(page, 'e2e重组')
  await ctxOn(page, 'e2e卷移甲')
  await hoverSubmenu(page, '移动到')
  await clickSubmenuItem(page, /^e2e重组$/) // 锚定：子菜单同时有「e2e重组卷」
  await expandVolume(page, 'e2e重组')
  await expect(chapterUnderVolume(page, 'e2e卷移甲')).toBeVisible()
  // 右键乙（e2e重组卷 卷内）→「并入上一章（…e2e卷移甲）」——按显示序跨卷命中，regex 容章号前缀
  await ctxOn(page, 'e2e卷移乙')
  await page
    .locator('.cm-menu')
    .getByRole('menuitem', { name: /并入上一章（.*e2e卷移甲）/ })
    .click()
  // 干跑确认：ui.ask → .cp-modal（标题「并入上一章」，多行预演 message），确认钮 并入
  const modal = page.locator('.cp-modal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.cp-title')).toHaveText('并入上一章')
  await modal.getByRole('button', { name: '并入', exact: true }).click()
  // 乙软删进回收站、甲仍在（卷内渲染面在——兼作 e2e重组 展开态闸，供下方撤销右键）
  await expect(page.locator('.tree-list')).not.toContainText('e2e卷移乙')
  await expect(chapterUnderVolume(page, 'e2e卷移甲')).toBeVisible()
  // 撤销并入（右键目标章甲）：目标回滚 + 源章按原路径还原——乙回到 e2e重组卷 卷内
  await ctxOn(page, 'e2e卷移甲')
  await page.locator('.cm-menu').getByRole('menuitem', { name: '撤销并入' }).click()
  await expect(modal).toBeVisible()
  await expect(modal.locator('.cp-title')).toHaveText('撤销并入')
  await modal.getByRole('button', { name: '撤销并入', exact: true }).click()
  await expandVolume(page, 'e2e重组卷')
  await expect(chapterUnderVolume(page, 'e2e卷移乙')).toBeVisible()
  await expect(chapterUnderVolume(page, 'e2e卷移甲')).toBeVisible()
})

test('净零收尾：两章软删，卷留态（不计章数 KPI）', async ({ page }) => {
  attachPageErrorBaseline(page, 'structure-volume-move')
  await gotoBook(page)
  await expandVolume(page, 'e2e重组')
  await expandVolume(page, 'e2e重组卷')
  // 两章软删进回收站（structure-ops 同款删除动线）——正文目录净零回 fixture 4 章，
  // 后序 switch-book 总览章节 KPI /^4/ 不连坐
  await deleteChapter(page, 'e2e卷移甲')
  await deleteChapter(page, 'e2e卷移乙')
  // 卷目录留态：卷无 UI 删除入口（卷右键菜单只有新建章节），tree-ops「e2e测试卷」
  // 先例同款；卷不计章节 KPI，后序 tree-ops test1 新建章落 lastVolume（startCreate
  // 自动展开落点卷、其断言不钉位置）不受扰
  await expect(volumeRow(page, 'e2e重组')).toBeVisible()
  await expect(volumeRow(page, 'e2e重组卷')).toBeVisible()
  await expect(page.locator('.tree-list')).not.toContainText('e2e卷移甲')
  await expect(page.locator('.tree-list')).not.toContainText('e2e卷移乙')
})
