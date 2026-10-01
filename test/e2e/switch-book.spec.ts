/**
 * 切书残留 e2e（批 6 二轮复审）：开 A 书总览 → 命令面板「返回书架」→ 开 B 书总览 →
 * 断言 B 书数据就位、A 书无残留——覆盖 Book.vue :key 重建 / workspace store 切换 /
 * OverviewView 挂载重拉这一整路（任一环坏掉 = B 页面长留 A 书标题/章数）。
 *
 * 数据面用 fixture 双轨书（长篇 4 章 / 短篇 2 章），总览 KPI 有确定性差异可断言。
 * 用量卡金额错位场景不入 e2e：e2e 服务端无 userDataPath，trace 恒空两书不可区分
 * （该场景由 WbUsageCard 组件测试 + loadGen/watch 单测覆盖）。
 *
 * P2-13（09-30 评审修复批）：全链只读（开书/切视图/路由跳转，不落盘）→ 迁独立 server
 * （端口偏移 9）+ 自有 workDir。此前关键脆点：总览章节 KPI /^4/ 是**共享 workDir 上
 * fixture 章数的实测值**——前序结构操作 spec 一旦收尾不净零（structure-ops 头注即为此
 * 存在）本 spec 必连坐红，而失败原因与「切书残留」这个被测语义毫无关系。独立 workDir 后
 * KPI 恒定来自 pristine fixture（不接 autosave 就不是写入链）。起停样板见
 * ./independent-server.ts；userDataPath: false 对齐 globalSetup 主 server 口径。
 */
import { test, expect } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'
import { startIndependentServer, type IndependentServer } from './independent-server.js'

let srv: IndependentServer

test.beforeAll(async () => {
  srv = await startIndependentServer({ tag: 'switch-book', offset: 9, userDataPath: false })
})

test.afterAll(async () => {
  await srv.close()
})

test('切书：A 总览 → 返回书架 → B 总览，B 数据就位且无 A 残留', async ({ page }) => {
  attachPageErrorBaseline(page, 'switch-book')
  await page.goto(`${srv.base}/`)

  // 开 A（长篇）→ ribbon 总览：标题/类型/章数就位
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.locator('.rbtn[data-tip^="总览"]').click()
  await expect(page.locator('.hero-title')).toHaveText('长篇测试书', { timeout: 20_000 })
  await expect(page.locator('.htag.solid')).toHaveText('长篇')
  const chaptersKpi = page.locator('.kpi', {
    has: page.locator('.kpi-label', { hasText: '章节' }),
  })
  await expect(chaptersKpi.locator('.kpi-val')).toHaveText(/^4/)

  // 命令面板返回书架（客户端路由切换，无整页刷新——这正是残留 bug 的触发方式）
  await page.keyboard.press('ControlOrMeta+p')
  await page.locator('.palette-input').fill('书架')
  await page.locator('.palette-item', { hasText: '返回书架' }).click()
  await expect(page).toHaveURL(/\/shelf/)

  // 开 B（短篇）→ 总览：标题/类型/章数全部换成 B 书口径
  await page.locator('.book-title', { hasText: '短篇测试集' }).click()
  await page.locator('.rbtn[data-tip^="总览"]').click()
  await expect(page.locator('.hero-title')).toHaveText('短篇测试集', { timeout: 20_000 })
  await expect(page.locator('.htag.solid')).toHaveText('短篇集')
  // 章数是 B 的 2（若切书不重载，会一直是 A 的 4 → 超时失败）
  await expect(chaptersKpi.locator('.kpi-val')).toHaveText(/^2/)
  await expect(page.locator('.hero-title')).not.toContainText('长篇测试书')
})
