/// <reference lib="dom" />
/**
 * 首启引导页（/welcome）e2e：浏览器降级文案 + 桌面桥取最近书库的成功/失败两态。
 *
 * 为什么单起 server：globalSetup 的 fixture workDir 让前端一路直进书架，其他 spec 都不经过
 * /welcome，该页需要自己的 server 才达得到。本 spec 只读本页，起独立 server 后不挤进共享
 * workDir 的顺序契约（端口偏移 11，登记见 ./e2e-ports.ts 偏移表）。
 *
 * 桌面态判定与桥契约：usePlatform 的 isDesktop 取 `window.clwritingDesktop.platform`
 * 是否为真值，且该判定在模块求值期快照一次——故桌面分支必须在应用脚本执行前用
 * page.addInitScript 注入假桥；Playwright 页面天然无此桥，正是浏览器降级分支的形态。
 */
import { test, expect, type Page } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'
import { startIndependentServer, type IndependentServer } from './independent-server.js'

let srv: IndependentServer

test.beforeAll(async () => {
  // 本页不依赖书库内容：workDir 由起服壳自建自清；userDataPath 同省（本页不读事件库）
  srv = await startIndependentServer({ tag: 'welcome', offset: 11, userDataPath: false })
})

test.afterAll(async () => {
  await srv.close()
})

const RECENTS = [
  { path: 'C:\\clw\\长篇甲', label: '长篇甲' },
  { path: 'C:\\clw\\短篇乙', label: '短篇乙' },
]

interface FakeBridgeOptions {
  /** getRecentLibraries 前 N 次调用抛错（0 = 首次即成功）——重试恢复臂靠它区分两次调用 */
  failFirst: number
  /** 抛错消息（错误态原样透出的断言对象） */
  failMessage: string
  recents: Array<{ path: string; label: string }>
}

/**
 * 应用脚本前注入假桌面桥。桩面取值依据（逐项对应真实消费点，多给无益、少给即破）：
 * - platform：usePlatform 的 isDesktop 判据（真值即桌面态）；
 * - onNavigate / onMenuAction：App.vue 挂载期无条件调用（点链不判空），缺则挂载炸；
 * - getSystemFonts：main.ts 空闲预热会调，缺则预热回调抛错；
 * - getRecentLibraries：本页唯一业务 IPC，调用次数落 window 供断言「重试真的重发」。
 */
async function installFakeBridge(page: Page, opts: FakeBridgeOptions): Promise<void> {
  await page.addInitScript((o: FakeBridgeOptions) => {
    let calls = 0
    const noop = (): (() => void) => () => {}
    ;(window as unknown as Record<string, unknown>)['clwritingDesktop'] = {
      platform: 'darwin',
      onNavigate: noop,
      onMenuAction: noop,
      getSystemFonts: () => Promise.resolve([]),
      getRecentLibraries: () => {
        calls += 1
        ;(window as unknown as Record<string, unknown>)['__welcomeRecentCalls'] = calls
        return calls <= o.failFirst ? Promise.reject(new Error(o.failMessage)) : Promise.resolve(o.recents)
      },
    }
  }, opts)
}

/** 假桥 getRecentLibraries 的调用次数（桥边界计数——应用内部不可观察，由桩落 window） */
async function recentCalls(page: Page): Promise<number> {
  return await page.evaluate(() => Number((window as unknown as Record<string, unknown>)['__welcomeRecentCalls'] ?? 0))
}

test('浏览器形态（无桌面桥）：降级文案可见，桌面入口与最近书库区不渲染', async ({ page }) => {
  attachPageErrorBaseline(page, 'welcome')
  await page.goto(`${srv.base}/welcome`)
  // 挂载见证：页根在场（避免只断言文案时把「整页没渲染」误判为通过）
  await expect(page.locator('.welcome')).toBeVisible()
  await expect(page.locator('.entries .no-desktop')).toHaveText(
    '书库管理仅在桌面版可用。请使用 CLWriting 桌面应用启动。',
  )
  // 非桌面分支是整块替换：新建/打开入口与最近书库区都不该出现（含「永久加载中」形态）
  await expect(page.locator('.entry')).toHaveCount(0)
  await expect(page.locator('.recent')).toHaveCount(0)
})

test('桌面桥：最近书库列表按 IPC 返回值渲染，挂载期只拉一次', async ({ page }) => {
  attachPageErrorBaseline(page, 'welcome')
  await installFakeBridge(page, { failFirst: 0, failMessage: '', recents: RECENTS })
  await page.goto(`${srv.base}/welcome`)
  await expect(page.locator('.recent-title')).toHaveText(/最近打开/)
  for (const r of RECENTS) {
    await expect(page.locator('.recent-label', { hasText: r.label })).toBeVisible()
    await expect(page.locator('.recent-path', { hasText: r.path })).toBeVisible()
  }
  await expect(page.locator('.recent-item')).toHaveCount(RECENTS.length)
  // 最近书库是补充信息，不取代新建/打开主入口
  await expect(page.locator('.entry.primary')).toBeVisible()
  expect(await recentCalls(page)).toBe(1)
})

test('桌面桥：最近书库 IPC 抛错 → 错误态 + 重试出口，重试重新发起并可恢复', async ({ page }) => {
  attachPageErrorBaseline(page, 'welcome')
  const failMessage = 'e2e 桩：最近书库读取失败'
  await installFakeBridge(page, { failFirst: 1, failMessage, recents: RECENTS })
  await page.goto(`${srv.base}/welcome`)

  // 失败态：错误文案 + 重试按钮；主入口不依赖该数据，保持可用（不顶掉、不永卡）
  await expect(page.locator('.recent .no-desktop')).toHaveText(`最近书库加载失败：${failMessage}`)
  const retry = page.locator('.retry-btn')
  await expect(retry).toBeVisible()
  await expect(page.locator('.entry.primary')).toBeVisible()
  await expect(page.locator('.recent-list')).toHaveCount(0)
  expect(await recentCalls(page)).toBe(1)

  // 重试 = 重新发起 IPC（计数递增），第二次成功 → 列表渲染、错误态撤除
  await retry.click()
  await expect(page.locator('.recent-label', { hasText: RECENTS[0]!.label })).toBeVisible()
  await expect(page.locator('.recent-item')).toHaveCount(RECENTS.length)
  await expect(page.locator('.recent .no-desktop')).toHaveCount(0)
  expect(await recentCalls(page)).toBe(2)
})
