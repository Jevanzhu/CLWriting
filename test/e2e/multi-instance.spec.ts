/**
 * 多库多窗（一库一实例·多进程，D1-D7 已拍板定案）打包态 e2e。
 *
 * 设计正本：Dev/Docs/02-执行/多库多窗-设计方案-2026-09-29.md（§三 决策定案）。
 * 断言锚点与决策逐条对应：
 * - D1 一库一实例：`--dir` 异库两实例并存且各显其库；同库第三实例起即退（Electron
 *   单实例锁作用域 = userData = 实例目录 `<home>/instances/<key>`，异库天然不互斥）；
 * - D2 key = sha256(platformCaseFold(dir)).slice(0,16)：实例目录按此 key 落位——本
 *   spec 直接调真实现算期望值（不手抄公式，公式改动此处同步红）；
 * - D3 目录拆分：实例目录持 logs/ 与 window-state.json；共享根不留 window-state.json
 *   （多库多窗前的旧档位只在读侧回落，写侧一律实例目录）；
 * - D7 诊断：实例日志首行「实例启动：key=… 来源=arg 书库=… 共享根=…」——来源=arg 同时
 *   钉住「--dir 优先于 cwd 发现」这条启动优先级（cwd 故意取中立目录，无 --dir 即引导页）。
 *
 * 挂 CLWRITING_E2E_RELEASE 环境门（先例 packaged-app-smoke.spec.ts）：常规
 * npm run test:e2e 跳过、不进常规用例轮。
 *
 * 跑：CLWRITING_E2E_RELEASE=1 npx playwright test test/e2e/multi-instance.spec.ts
 * （需先打包：npm run build:desktop:dir → dist-electron/mac-arm64/CLWriting.app；
 * win 缺省找 dist-electron/win-unpacked/，可经 CLWRITING_E2E_APP_BIN 覆盖二进制定位）。
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { _electron } from 'playwright'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { libraryInstanceKey } from '../../src/fs/user-data-path.js'
import { LONG_BOOK, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { rmTempDirRetry } from './tmp-cleanup.js'
import { attachPageErrorBaseline, dismissStartupNotices } from './page-error-baseline.js'

test.skip(!process.env['CLWRITING_E2E_RELEASE'], '多库多窗 e2e：CLWRITING_E2E_RELEASE=1 才跑（需打包产物）')

// 二进制定位同 packaged-app-smoke（必须 resolve 成绝对路径——launch 的 cwd 指向中立
// 目录，spawn 会以 cwd 解析相对路径）
const DEFAULT_APP_BIN =
  process.platform === 'win32'
    ? join('dist-electron', 'win-unpacked', 'CLWriting.exe')
    : join('dist-electron', 'mac-arm64', 'CLWriting.app', 'Contents', 'MacOS', 'CLWriting')
const APP_BIN = resolve(process.env['CLWRITING_E2E_APP_BIN'] || DEFAULT_APP_BIN)

/** 第二库之书——与双轨库书名不重叠，书卡标题即「窗口显示的是哪个库」的断言锚点 */
const SECOND_BOOK = '第二库之书'

/** 造单书书库（B 库）：书库身份与双轨库在 UI 上可区分（书卡标题），book.yaml 取
 *  双轨长书同款字段面（缺字段可能被书架侧判为无效登记而不渲染） */
function makeSingleBookLibrary(): string {
  const lib = mkdtempSync(join(tmpdir(), 'clwriting-lib-single-'))
  mkdirSync(join(lib, '.clwriting'), { recursive: true })
  writeFileSync(
    join(lib, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: SECOND_BOOK, path: `甲/${SECOND_BOOK}`, kind: 'long' }) + '\n',
  )
  const root = join(lib, '甲', SECOND_BOOK)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 第二库之书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: [成长线]\nbudget:\n  calls_per_chapter: 8\nstyle:\n  injection: light\nauto:\n  confirm_outline: false\n  batch_size: 1\ngrowth: {}\n',
  )
  writeFileSync(
    join(root, '写作', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n场景: 对话\n---\n第二库正文开篇，独立于双轨库。\n',
  )
  return lib
}

/** 实例日志行（JSONL）取 msg 字段原文——断言只认人读行，不锁 JSON 结构 */
function readLogMsgs(logsDir: string): string[] {
  if (!existsSync(logsDir)) return []
  return readdirSync(logsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(logsDir, f), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return String((JSON.parse(line) as { msg?: unknown }).msg ?? '')
          } catch {
            return ''
          }
        }),
    )
}

/** 干净退出：close() 即在主进程求值 app.quit()（真实优雅退出链：flush → 停 server
 *  child → 撤实例锁）；15s 竞速兜底后按 release-smoke 的 SIGTERM→7s SIGKILL 口径收尾。
 *  幂等——用例内已关过（Playwright 随之释放 ElectronApplication 连接，此后 app.process()
 *  抛 TypeError）或从未启动的实例直接返回（afterAll 与用例内关闭可叠加调用）。 */
async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return
  let proc: ChildProcess | undefined
  try {
    proc = app.process()
  } catch {
    return // 连接已释放 = 本实例此前已优雅关停，无需再收
  }
  if (!proc || proc.exitCode !== null) return
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
  if (proc.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc!.kill('SIGKILL')
        resolve()
      }, 7_000)
      proc!.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      proc!.kill('SIGTERM')
    })
  }
}

/** 起实例并等其自行退出（同库第三实例语义：拿不到单实例锁 → app.quit，不开窗） */
function waitExit(proc: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      rej(new Error(`子实例未在 ${timeoutMs}ms 内退出（同库单实例防线失效）`))
    }, timeoutMs)
    proc.once('exit', (code, signal) => {
      clearTimeout(timer)
      res({ code, signal })
    })
    proc.once('error', (e) => {
      clearTimeout(timer)
      rej(e)
    })
  })
}

let appA: ElectronApplication | undefined
let appB: ElectronApplication | undefined
/** 共享根（CLW_SMOKE_USER_DATA）——真实用户库隔离，实例目录嵌套其下 */
let home = ''
const tmpDirs: string[] = []

test.afterAll(async () => {
  await closeApp(appA)
  await closeApp(appB)
  // 退出落定后再删临时目录（子进程收尾后句柄可能短暂未释放，rmTempDirRetry 重试口径）
  for (const d of tmpDirs) rmTempDirRetry(d)
  if (home) rmTempDirRetry(home)
})

test('两库并行两实例各显其库 → 同库第三实例自动退出 → 实例目录/日志/窗口几何按库隔离', async () => {
  test.setTimeout(300_000) // 打包冷启动 ×2（fork server + 握手 + 窗口加载）+ 第三实例起退
  expect(existsSync(APP_BIN), `打包产物缺失（${APP_BIN}）——先 npm run build:desktop:dir`).toBe(true)

  home = mkdtempSync(join(tmpdir(), 'clwriting-multi-userdata-'))
  const libA = makeDualTrackWorkdir()
  const libB = makeSingleBookLibrary()
  tmpDirs.push(libA, libB)
  // cwd 取中立目录（共享根）：无 --dir 时 findWorkDir(cwd) 发现不到任何书库 → 引导页。
  // 于是「窗口显的是 --dir 指定库」不是 cwd 兜底的假绿（日志 来源=arg 为第二重钉）。
  const launchOpts = { executablePath: APP_BIN, cwd: home, env: { ...process.env, CLW_SMOKE_USER_DATA: home } }

  // ── 实例 A：--dir libA ────────────────────────────────
  appA = await _electron.launch({ ...launchOpts, args: ['--dir', libA] })
  const pageA = await appA.firstWindow()
  attachPageErrorBaseline(pageA, 'multi-instance-a')
  await dismissStartupNotices(pageA)
  await expect(pageA.locator('button', { hasText: LONG_BOOK }).first()).toBeVisible({ timeout: 60_000 })

  // ── 实例 B：--dir libB（同共享根、异库 → 单实例锁不互斥）────────
  appB = await _electron.launch({ ...launchOpts, args: ['--dir', libB] })
  const pageB = await appB.firstWindow()
  attachPageErrorBaseline(pageB, 'multi-instance-b')
  await dismissStartupNotices(pageB)
  await expect(pageB.locator('button', { hasText: SECOND_BOOK }).first()).toBeVisible({ timeout: 60_000 })
  // 交叉验证：B 的窗口里没有 A 的书（各实例各读各库，不是「谁后开谁覆盖」）
  await expect(pageB.locator('button', { hasText: LONG_BOOK })).toHaveCount(0)
  expect(appA.process()?.exitCode, 'A 应与 B 并存').toBeNull()
  expect(appB.process()?.exitCode, 'B 应与 A 并存').toBeNull()

  // ── D2/D3/D7：实例目录按 key 派生，各持自己的 logs，启动行落实例日志 ────────
  const keyA = libraryInstanceKey(libA)
  const keyB = libraryInstanceKey(libB)
  expect(keyA, '异库 key 必不同（同库才会撞锁）').not.toBe(keyB)
  const instA = join(home, 'instances', keyA)
  const instB = join(home, 'instances', keyB)
  const msgsA = readLogMsgs(join(instA, 'logs'))
  const msgsB = readLogMsgs(join(instB, 'logs'))
  expect(
    msgsA.some((m) => m.includes('实例启动：key=') && m.includes('来源=arg') && m.includes(`书库=${libA}`)),
    `A 实例日志应含「来源=arg 书库=${libA}」启动行；实收：${JSON.stringify(msgsA.slice(0, 6))}`,
  ).toBe(true)
  expect(
    msgsB.some((m) => m.includes('实例启动：key=') && m.includes('来源=arg') && m.includes(`书库=${libB}`)),
    `B 实例日志应含「来源=arg 书库=${libB}」启动行；实收：${JSON.stringify(msgsB.slice(0, 6))}`,
  ).toBe(true)

  // ── D1：同库第三实例起即退（锁作用域=实例目录），A 不受影响 ────────────────
  const third = spawn(APP_BIN, ['--dir', libA], {
    cwd: home,
    env: { ...process.env, CLW_SMOKE_USER_DATA: home },
    stdio: 'ignore',
  })
  const thirdExit = await waitExit(third, 60_000)
  expect(thirdExit.code, '同库第三实例应优雅自退（app.quit → exit 0）').toBe(0)
  expect(appA.process()?.exitCode, '第三实例起退不得影响持锁实例 A').toBeNull()
  // A 仍可用（窗口未被打断，书架仍在）
  await expect(pageA.locator('button', { hasText: LONG_BOOK }).first()).toBeVisible({ timeout: 10_000 })

  // ── D3：干净退出后窗口几何落实例目录；共享根不留 window-state.json ─────────
  await closeApp(appA)
  await expect
    .poll(() => existsSync(join(instA, 'window-state.json')), {
      timeout: 10_000,
      message: '实例 A 退出后应在自己的实例目录留下 window-state.json',
    })
    .toBe(true)
  expect(
    existsSync(join(home, 'window-state.json')),
    '共享根不得出现 window-state.json（写侧一律实例目录；共享根只作旧档读侧回落）',
  ).toBe(false)
})
