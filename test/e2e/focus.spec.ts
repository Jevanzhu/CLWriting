/**
 * T1.6 专注模式（M11 E1）：入口切换 → 沉浸隐藏 → 退出还原。
 *
 * 完全沉浸批（2026-08-23）：focusMode = 全部 UI 隐藏（Ribbon/TabBar/状态栏/侧栏）+ 全屏
 * + 打字机（滚动居中 + 焦点渐隐，行为契约单测锁 typewriter.test.ts，本 spec 锁真实
 * 浏览器几何/透明度）。退出走 Esc（完全沉浸下 TabBar 已隐藏，原「再点按钮」路径不
 * 存在；e2e 跑浏览器形态，无桌面桥 → 全屏走 HTML5 API，click 前置有手势）。
 *
 * 2026-08-27 批二：渐隐升级为「只在写作位」——浏览态（进专注未输入/滚轮回看/输入停
 * 8s）全亮，输入才渐隐；左侧新增专注统计条（本次/速度/本章目标，FocusStatsBar）。
 */
import { test, expect } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'

// 视口拉宽到侧位充足（(1680-1020)/2=330px ≥ 12 间距 + 150 条宽）：专注态浏览器形态走
// HTML5 全屏，全屏窗口协议禁改 setViewportSize，故须在 context 创建时定视口
test.use({ viewport: { width: 1680, height: 1000 } })

test('专注模式：沉浸隐藏 + Esc 退出还原', async ({ page }) => {
  attachPageErrorBaseline(page, 'focus')
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  // 打开一章（纸张宽度断言需要 .doc-page 在场；空态编辑器无纸张）
  await page.getByText('初入宗门').first().click()
  await expect(page.locator('.doc-page')).toBeVisible()
  // 初始侧栏展开
  await expect(page.locator('.ws-left')).not.toHaveClass(/collapsed/)
  // 点 Focus（ViewHeader 唯一 action-btn）
  const focusBtn = page.locator('[data-tip*="专注"]')
  await focusBtn.click()
  await expect(page.locator('.ws-left')).toHaveClass(/collapsed/)
  await expect(page.locator('.ws-right')).toHaveClass(/collapsed/)
  // 完全沉浸：外壳 ws-focus class + TabBar 隐藏 + 右下角退出按钮出现
  await expect(page.locator('.ws-shell')).toHaveClass(/ws-focus/)
  await expect(page.locator('.tabbar')).toBeHidden()
  await expect(page.locator('.ws-focus-exit')).toBeVisible()
  // 排版浮动条（2026-08-24 批；2026-08-27 修订定位贴纸张右缘）：竖状常驻 + 字号/
  // 行距/纸宽三滑杆（e2e 浏览器形态无桌面桥 → 字体区隐藏）；纸张宽度回归设置值
  // （--page-width 1020px，不再 +160 放大）
  await expect(page.locator('.focus-format-bar')).toBeVisible()
  await expect(page.locator('.focus-format-bar .ffb-range')).toHaveCount(3)
  await expect(page.locator('.focus-format-bar .ffb-select')).toHaveCount(0)
  await expect(page.locator('.doc-page')).toHaveCSS('max-width', '1020px')
  // 浮动条贴纸张右缘（2026-08-27 修订）：条左缘应落在纸张右缘右侧 0~40px
  // （12px 间距 + 渲染容差），而不是钉在窗口右缘（视口已在本 spec 头部拉宽）
  const ffbBox = await page.locator('.focus-format-bar').boundingBox()
  const paperBox = await page.locator('.doc-page').boundingBox()
  expect(ffbBox).toBeTruthy()
  expect(paperBox).toBeTruthy()
  const ffbGap = ffbBox!.x - (paperBox!.x + paperBox!.width)
  expect(ffbGap).toBeGreaterThanOrEqual(0)
  expect(ffbGap).toBeLessThanOrEqual(40)
  // Esc 退出 → 还原
  await page.keyboard.press('Escape')
  await expect(page.locator('.ws-left')).not.toHaveClass(/collapsed/)
  await expect(page.locator('.ws-right')).not.toHaveClass(/collapsed/)
  await expect(page.locator('.ws-shell')).not.toHaveClass(/ws-focus/)
  await expect(page.locator('.tabbar')).toBeVisible()
  await expect(page.locator('.focus-format-bar')).toBeHidden()
  await expect(focusBtn).not.toHaveClass(/active/)
})

test('专注打字机：滚动居中 + 上下文按行距渐隐', async ({ page }) => {
  attachPageErrorBaseline(page, 'focus')
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText('初入宗门').first().click()
  await page.locator('.doc-page').waitFor()
  await page.locator('[data-tip*="专注"]').click()
  await page.locator('.focus-format-bar').waitFor()

  // 灌长文把光标置于文末。回归锁：旧 bug 中 CmHost 主题的 padding:0 简写按序覆盖了
  // 打字机底部余量 → 文末永不居中（漂移 ~208px、滚动钉底）；特异性修复后应 ≤ 容差。
  // 置位：点末行 + End 到行尾（打字机有上下 50vh 余量后 .cm-content 盲点中心会落进
  // padding 空白带、光标被映射到文档边缘——必须点真实文本行定位）
  await page.locator('.cm-line').last().click()
  await page.keyboard.press('End')
  await page.keyboard.insertText('\n'.repeat(300) + '末行标记')
  await expect(page.locator('.cm-activeLine')).toContainText('末行标记')

  const get = () => page.evaluate(() => {
    const scroller = document.querySelector('.cm-scroller') as HTMLElement
    const content = document.querySelector('.cm-content') as HTMLElement
    const active = document.querySelector('.cm-activeLine') as HTMLElement
    const lines = Array.from(content.querySelectorAll('.cm-line')) as HTMLElement[]
    const idx = lines.indexOf(active)
    const sr = scroller.getBoundingClientRect()
    const ar = active.getBoundingClientRect()
    const op = (d: number): string => (idx - d >= 0 ? getComputedStyle(lines[idx - d]!).opacity : '-1')
    return {
      drift: Math.round(ar.top + ar.height / 2 - (sr.top + sr.height / 2)),
      paddingTop: getComputedStyle(content).paddingTop,
      paddingBottom: getComputedStyle(content).paddingBottom,
      transition: getComputedStyle(active).transitionDuration,
      op1: op(1), op2: op(2), op3: op(3), op5: op(5), op8: op(8), op12: op(12),
    }
  })

  // 滚动居中：当前行中心与滚动容器中心偏差 ≤40px；上下半屏余量非 0（首行/文末都可居中）
  const m = await get()
  expect(Math.abs(m.drift)).toBeLessThanOrEqual(40)
  expect(m.paddingTop).not.toBe('0px')
  expect(m.paddingBottom).not.toBe('0px')
  // 渐隐分带：亮窗 ±2 行全亮，之外 d=3~4 → 0.72 / d=5~6 → 0.5 / d=7~9 → 0.32 / d≥10 → 0.16
  expect(m.op1).toBe('1')
  expect(m.op2).toBe('1')
  expect(m.op3).toBe('0.72')
  expect(m.op5).toBe('0.5')
  expect(m.op8).toBe('0.32')
  expect(m.op12).toBe('0.16')
  // 渐隐过渡动画载体在（0.25s）
  expect(m.transition).toContain('0.25s')

  // 逐字输入后滚动居中仍保持（真实打字路径）
  for (let i = 0; i < 5; i++) await page.keyboard.type('字', { delay: 30 })
  expect(Math.abs((await get()).drift)).toBeLessThanOrEqual(40)
  // 回车换行后滚动居中仍保持
  for (let i = 0; i < 3; i++) await page.keyboard.press('Enter', { delay: 30 })
  expect(Math.abs((await get()).drift)).toBeLessThanOrEqual(40)

  // 首行也居中（2026-08-27 批四）：内容上方 50vh 余量给 scrollTop 滚动空间——
  // 无上方余量时钳 0，首行只能贴顶（编辑已有文档从第一行写起的关键回归）
  await page.locator('.cm-line').first().click()
  await page.keyboard.type('首', { delay: 30 })
  const first = await get()
  expect(first.drift).toBeGreaterThanOrEqual(-40)
  expect(first.drift).toBeLessThanOrEqual(40)
})

test('专注统计条 + 浏览态全亮：输入渐隐 → 滚轮回看全亮 → 再输入渐隐回来', async ({ page }) => {
  attachPageErrorBaseline(page, 'focus')
  await page.goto('/')
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText('初入宗门').first().click()
  await page.locator('.doc-page').waitFor()
  await page.locator('[data-tip*="专注"]').click()
  await page.locator('.focus-stats-bar').waitFor()

  // 统计条渲染：本次/速度两区在场（本章目标区依赖三级配置，单测已锁，此处不强断）
  const statsBar = page.locator('.focus-stats-bar')
  await expect(statsBar.locator('.fsb-label', { hasText: '本次' })).toBeVisible()
  await expect(statsBar.locator('.fsb-label', { hasText: '速度' })).toBeVisible()
  // R69-8（十七轮）：测量前等布局静置——两重异步源：①进入专注的 HTML5 全屏在无头环境
  // 会把有效视口重置到屏幕尺寸（与 1680 context 视口不同）；②左栏收拢有宽度过渡动画，
  // 未静置即测量会取到中途几何（本 spec 头部 1680 视口下公式恒 12px，中途值随机负）。
  await expect(page.locator('.ws-left')).toHaveClass(/collapsed/)
  await page.waitForTimeout(500)
  // 左侧贴纸张左缘（与右侧排版条镜像）：条右缘应落在纸张左缘左侧 0~40px
  // （R69-8 产品侧配套：窄边距下条宽 clamp 收缩，全屏重置视口/窄屏也保 12px 间隙）
  const barBox = await statsBar.boundingBox()
  const paperBox = await page.locator('.doc-page').boundingBox()
  expect(barBox).toBeTruthy()
  expect(paperBox).toBeTruthy()
  const sbGap = paperBox!.x - (barBox!.x + barBox!.width)
  expect(sbGap).toBeGreaterThanOrEqual(0)
  expect(sbGap).toBeLessThanOrEqual(40)

  // 浏览态（进专注未输入）：全亮起步——视口内无任何渐隐行
  const fadeCount = () => page.locator('.cm-line[class*="tw-fade-"]').count()
  await expect.poll(fadeCount, { timeout: 2000 }).toBe(0)

  // 输入（灌长文置光标于文末行尾——同打字机用例：盲点 .cm-content 中心会落进 padding 带）
  await page.locator('.cm-line').last().click()
  await page.keyboard.press('End')
  await page.keyboard.insertText('\n'.repeat(30) + '末尾标记')
  await expect.poll(fadeCount, { timeout: 2000 }).toBeGreaterThan(0)
  await expect(statsBar.locator('.fsb-main').first()).toHaveText(/\+[1-9]\d* 字/)

  // 滚轮回看 → 立即全亮（不等 idle 计时）
  const scroller = await page.locator('.cm-scroller').boundingBox()
  await page.mouse.move(scroller!.x + scroller!.width / 2, scroller!.y + scroller!.height / 2)
  await page.mouse.wheel(0, -40)
  await expect.poll(fadeCount, { timeout: 2000 }).toBe(0)

  // 再输入 → 渐隐亮窗回来
  await page.keyboard.type('续写', { delay: 30 })
  await expect.poll(fadeCount, { timeout: 2000 }).toBeGreaterThan(0)

  // 退出专注：统计条随沉浸态卸载
  await page.locator('.ws-focus-exit').click()
  await expect(statsBar).toBeHidden()
})
