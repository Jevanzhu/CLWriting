/**
 * 打包态应用冒烟：启动打包产物（electron-builder --dir 的 CLWriting.app）走 UI 动线，
 * 钉住「打包态 fontlist 外置二进制 → spawn → IPC → UI 字体下拉」整链。
 * 挂 CLWRITING_E2E_RELEASE 环境门（先例 release-smoke.spec.ts），常规
 * npm run test:e2e 跳过、不进常规用例轮。
 *
 * 动线：启动打包应用（CLW_SMOKE_USER_DATA 指临时 userData 隔离真实用户库；cwd 指临时
 * 双轨 fixture 书库 → findWorkDir 即命中，跳过 welcome 直达书架）→ 点书卡进工作台 →
 * 打开设置弹窗 → 「外观与主题」分类 → 断言 [aria-label="界面中文字体"] 原生 select 的
 * options ≥ 2（默认项 + ≥1 真实字体）→ 干净退出（app.quit 优雅链 + 信号兜底）。
 *
 * 2026-09-17 mac 实机人工验证先例：设置入口是 button[aria-label*="设置"]（data-tip 由
 * TooltipHost 同步为 aria-label，非 title 属性）；mac 上 FontPicker 渲染为原生
 * <select>；书卡是含书名文本的 button。
 *
 * 跑：CLWRITING_E2E_RELEASE=1 npx playwright test test/e2e/packaged-app-smoke.spec.ts
 * （需先打包：npm run build:desktop:dir → dist-electron/mac-arm64/CLWriting.app；
 * win 缺省找 dist-electron/win-unpacked/，可经 CLWRITING_E2E_APP_BIN 覆盖二进制定位）。
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { _electron } from 'playwright'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { makeDualTrackWorkdir } from '../studio/fixtures.js'
import { rmTempDirRetry } from './tmp-cleanup.js'
import { attachPageErrorBaseline, dismissStartupNotices } from './page-error-baseline.js'

test.skip(!process.env['CLWRITING_E2E_RELEASE'], '发布 smoke：CLWRITING_E2E_RELEASE=1 才跑（需打包产物）')

// 二进制定位：缺省按平台找 electron-builder --dir 产物；CLWRITING_E2E_APP_BIN 可覆盖。
// 必须 resolve 成绝对路径——launch 的 cwd 指向临时书库，spawn 会以 cwd 解析相对路径
const DEFAULT_APP_BIN =
  process.platform === 'win32'
    ? join('dist-electron', 'win-unpacked', 'CLWriting.exe')
    : join('dist-electron', 'mac-arm64', 'CLWriting.app', 'Contents', 'MacOS', 'CLWriting')
const APP_BIN = resolve(process.env['CLWRITING_E2E_APP_BIN'] || DEFAULT_APP_BIN)

let app: ElectronApplication | undefined
let smokeUserData = ''
let smokeWorkDir = ''

test.afterAll(async () => {
  // 干净退出：_electron 的 close() 即在主进程求值 app.quit()（真实优雅退出链：flush →
  // 停 server child → 撤实例锁）；15s 竞速兜底后按 release-smoke 的 SIGTERM→7s SIGKILL
  // 口径收尾，防挂起拖死 afterAll
  if (app) {
    const proc = app.process()
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
    if (proc && proc.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL')
          resolve()
        }, 7_000)
        proc.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        proc.kill('SIGTERM')
      })
    }
  }
  // 退出落定后再删临时目录（子进程收尾后句柄可能短暂未释放，rmTempDirRetry 重试口径）
  if (smokeUserData) rmTempDirRetry(smokeUserData)
  if (smokeWorkDir) rmTempDirRetry(smokeWorkDir)
})

test('打包态应用：进书 → 设置「外观与主题」→ 界面中文字体下拉列出系统字体', async () => {
  // v1.0.0-rc.0 发布修复批附批：120s→180s——mac x64 包冷 Rosetta 翻译首启显著慢于
  // 原生（win 原生冷机实录 ready 恰落 ~60s 边界，翻译态更甚），留同量级裕度；
  // 步内 waitFor（30s/20s）在启动完成后执行、彼时已暖，不动。
  test.setTimeout(180_000) // 打包冷启动（fork server + 握手 + 窗口加载）+ 字体枚举，给足
  expect(existsSync(APP_BIN), `打包产物缺失（${APP_BIN}）——先 npm run build:desktop:dir`).toBe(true)

  // userData 隔离（关键）：CLW_SMOKE_USER_DATA（main.ts 最小 env 钩子）指向临时目录，
  // 绝不写真实 ~/Library/Application Support/CLWriting
  smokeUserData = mkdtempSync(join(tmpdir(), 'clwriting-smoke-userdata-'))
  smokeWorkDir = makeDualTrackWorkdir()

  app = await _electron.launch({
    executablePath: APP_BIN,
    cwd: smokeWorkDir,
    env: { ...process.env, CLW_SMOKE_USER_DATA: smokeUserData },
  })
  const page = await app.firstWindow()
  attachPageErrorBaseline(page, 'packaged-app-smoke')

  // 书架：fixture 双书（长篇测试书/短篇测试集），书卡为含书名文本的 button（hero 卡
  // 与网格卡可能同名命中，取 first）；启动通告横幅若弹先关（e2e 既有口径）
  await dismissStartupNotices(page)
  const bookCard = page.locator('button', { hasText: '长篇测试书' }).first()
  await bookCard.waitFor({ state: 'visible', timeout: 30_000 })
  await bookCard.click()

  // 工作台：Ribbon 设置按钮（data-tip「设置（⌘,）」由 TooltipHost 同步为 aria-label）
  const settingsBtn = page.locator('button[aria-label*="设置"]').first()
  await settingsBtn.waitFor({ state: 'visible', timeout: 30_000 })
  await settingsBtn.click()

  // 设置弹窗 → 「外观与主题」分类（缺省即该 tab，显式点钉住动线）
  const dialog = page.locator('[role="dialog"][aria-label="设置"]')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '外观与主题' }).click()

  // 断言链终点：mac 原生 select（非 win FontPicker 形态）——options = 默认项 + 真实
  // 字体若干；字体经 fontlist 外置二进制 spawn → IPC 异步到达，轮询等列表落位
  const fontSelect = dialog.locator('select[aria-label="界面中文字体"]')
  await expect(fontSelect).toBeVisible()
  await expect
    .poll(async () => await fontSelect.locator('option').count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2)
  await expect
    .poll(async () => await fontSelect.locator('option:not([value=""])').count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1)

  // 干净退出在 afterAll（app.quit 优雅链 + 兜底信号）
})
