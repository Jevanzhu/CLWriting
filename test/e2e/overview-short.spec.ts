/**
 * P2-PROD-3：短篇概览节奏曲线（字数曲线）e2e。
 *
 * 背景：短篇与长篇已统一「章」概念，正文 fm 用 章号（无 篇号）。
 * 短篇 Overview 复用长篇 curve 面板（v-if rhythmData && curve.length），
 * 不按 kind 分支——本 spec 验证短篇集字数曲线正常渲染非空白。
 *
 * fixture：makeShortBook 的「短篇测试集」（2 章：雨夜门铃/红伞，均带 章号 fm）。
 * 独立 server（偏移 13，见 e2e-ports.ts 偏移表）+ mock driver，不污染 globalSetup 的 18999。
 * 起停样板见 ./independent-server.ts。
 */
import { test, expect } from '@playwright/test'
import { SHORT_BOOK } from '../studio/fixtures.js'
import { attachPageErrorBaseline } from './page-error-baseline.js'
import { startIndependentServer, type IndependentServer } from './independent-server.js'

let srv: IndependentServer

test.beforeAll(async () => {
  srv = await startIndependentServer({ tag: 'overview-short', offset: 13 })
})

test.afterAll(async () => {
  await srv.close()
})

test('短篇概览：字数曲线面板非空白（2 章数据点 + 标题）', async ({ page }) => {
  attachPageErrorBaseline(page, 'overview-short')
  // 进短篇集工作区（书架 → 点击书卡）
  await page.goto(`${srv.base}/shelf`)
  await page.locator('.book-title', { hasText: SHORT_BOOK }).first().click()
  await expect(page.locator('.ws-shell')).toBeVisible()

  // ribbon 总览按钮 → 切到 overview
  await page.locator('.rbtn[data-tip*="总览"]').click()
  await expect(page.locator('.overview')).toBeVisible()

  // 字数曲线面板渲染（2 章数据点 + 标题非空）
  const panel = page.locator('.panel', { hasText: '字数曲线' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.head-legend')).toContainText('2 章')
  await expect(panel.locator('svg[aria-label="字数曲线"]')).toBeVisible()
  // 2 章数据点 → 面积/描边 path 至少 2 条（非空白证明有数据）
  await expect(panel.locator('.chart-svg path')).toHaveCount(2)
})
