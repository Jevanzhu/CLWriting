/**
 * R0916-5b（2026-09-16）：main.test.ts（kk-P2-8 主进程自动化，2800 行）按 describe
 * 域拆分件之一——「窗口自愈/韧性」域：R51-A-2（did-fail-load 主框架自愈：退避重试 +
 * 预算封顶 + 稳定窗复位）+ R44-15/R44-17（子窗工作区钳制 + uncaughtException 停机
 * 兜底）+ R0910-W（销毁态 webContents 不炸穿 closed 清理链）+ R0910-W（窗口循环
 * 冒烟门 CLW_SMOKE_WINDOW_CYCLE；与 closed 清理链同批，归并同件）。
 * 用例自原文件 1949-2181 与 2747-2800 行整块原样搬移（describe/test 名称、断言、
 * mock 行为零变化）；mock 工厂/装置见 ./main-fixtures.js，④批 P2 监听器治理 harness
 * 见 ./main-process-harness.js（R0915-P2 承重墙，逐件复刻；本件含两处
 * vi.spyOn(process,'on') 竞态用例，与包装的共存语义见该头注）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import {
  M,
  trustedEvent,
  captureMainTestEnvPrev,
  bootstrapMainFixture,
  restoreMainTestEnv,
  cleanupMainTmpDirs,
} from './main-fixtures.js'
import {
  installMainProcessListenerHarness,
  removeTrackedProcessListeners,
  restoreMainProcessListenerHarness,
} from './main-process-harness.js'

// ── ④批 P2 监听器治理 harness（R0915-P2 承重墙，R0916-5b 随拆分逐件复刻）───────────
// 模块级包装 process.on/once 透传记账 → afterEach 逐监听器拆除 → afterAll 兜底还原；
// 语义与原文详见 ./main-process-harness.js 头注。
installMainProcessListenerHarness()
const prevEnv = captureMainTestEnvPrev()

beforeAll(async () => {
  await bootstrapMainFixture()
})

afterAll(() => {
  // R0915-P2：末用例异步尾（重导入 whenReady 链迟到注册）兜底拆除 + 还原包装方法，
  // 零残留出文件（同 worker 后续测试文件不受影响）。
  removeTrackedProcessListeners()
  restoreMainProcessListenerHarness()
  restoreMainTestEnv(prevEnv)
  cleanupMainTmpDirs()
})

afterEach(() => {
  // R0915-P2：拆除本用例窗口内经包装注册的 process 监听器（含重导入 main.js 的
  // 六件套）——已 once 触发或调用方自拆的形态 removeListener 幂等无害；记账清空
  // 防单调增长。
  removeTrackedProcessListeners()
})

// ── R51-A-2（五十一轮）：主框架加载失败自愈——退避重试 + 预算封顶 + 稳定窗复位 ──
// 自愈 reload 落在 server 退避重启窗时加载失败，did-fail-load 原无人处理 → 白屏滞留
//（打包态无人工出口）。修复：主框架失败 2s 起倍增（15s 封顶）共 5 次重试。
describe('R51-A-2: did-fail-load 自愈', () => {
  async function freshModuleFake(): Promise<(typeof M.windows)[number]> {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await vi.advanceTimersByTimeAsync(0) // bootstrap + 首窗创建落定（fake timers 下的微任务排空）
    return M.windows.at(-1)!
  }
  type FailH = (e: unknown, code: number, desc: string, url: string, isMainFrame: boolean) => void

  it('主框架失败 → 2s 退避后 reload；-3 / 子框架不重试', async () => {
    vi.useFakeTimers()
    try {
      const win = await freshModuleFake()
      const h = win.webContents.handlers['did-fail-load']!.at(-1)! as FailH
      const r0 = win.webContents.reloaded
      h({}, -3, 'ERR_ABORTED', 'http://x', true) // 新加载顶替旧加载：常态事件
      h({}, -2, 'ERR_FAILED', 'http://x', false) // 子框架：随主框架重载收敛
      await vi.advanceTimersByTimeAsync(60_000)
      expect(win.webContents.reloaded).toBe(r0)
      h({}, -2, 'ERR_FAILED', 'http://x', true)
      expect(win.webContents.reloaded).toBe(r0) // 未到退避点
      await vi.advanceTimersByTimeAsync(2_000)
      expect(win.webContents.reloaded).toBe(r0 + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('连续失败倍增退避（2/4/8/15/15s）预算封顶——第 6 次起不再重试，封顶留痕', async () => {
    vi.useFakeTimers()
    try {
      const win = await freshModuleFake()
      const h = win.webContents.handlers['did-fail-load']!.at(-1)! as FailH
      const r0 = win.webContents.reloaded
      for (const d of [2_000, 4_000, 8_000, 15_000, 15_000]) {
        h({}, -2, 'ERR_FAILED', 'http://x', true)
        await vi.advanceTimersByTimeAsync(d)
      }
      expect(win.webContents.reloaded).toBe(r0 + 5)
      const err0 = M.logErrors.length
      h({}, -2, 'ERR_FAILED', 'http://x', true) // 第 6 次：预算耗尽
      await vi.advanceTimersByTimeAsync(60_000)
      expect(win.webContents.reloaded).toBe(r0 + 5)
      expect(M.logErrors.length).toBeGreaterThan(err0) // 封顶留痕（等待人工处理）
    } finally {
      vi.useRealTimers()
    }
  })

  it('成功载入 + 稳定窗活满 → 计数复位（预算耗尽后可再获整段预算）', async () => {
    vi.useFakeTimers()
    try {
      const win = await freshModuleFake()
      const h = win.webContents.handlers['did-fail-load']!.at(-1)! as FailH
      const fin = win.webContents.handlers['did-finish-load']!.at(-1)!
      const r0 = win.webContents.reloaded
      for (const d of [2_000, 4_000, 8_000, 15_000, 15_000]) {
        h({}, -2, 'ERR_FAILED', 'http://x', true)
        await vi.advanceTimersByTimeAsync(d)
      }
      h({}, -2, 'ERR_FAILED', 'http://x', true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(win.webContents.reloaded).toBe(r0 + 5) // 预算耗尽
      fin() // 成功载入
      await vi.advanceTimersByTimeAsync(5 * 60_000) // 稳定窗活满 → crashes/loadFails 清零
      h({}, -2, 'ERR_FAILED', 'http://x', true) // 复位后重新可自愈
      await vi.advanceTimersByTimeAsync(2_000)
      expect(win.webContents.reloaded).toBe(r0 + 6)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── R44-15/R44-17（四十四轮）：子窗尺寸钳制 + 崩溃期 child best-effort kill ──────
describe('R44-15/R44-17: 子窗工作区钳制 + uncaughtException 停机兜底', () => {
  async function freshModule(): Promise<(typeof M.windows)[number]> {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    return M.windows.at(-1)!
  }

  // R44-15：小屏/高 DPI 工作区（600×400）下书架/书库子窗的 minWidth/minHeight 硬下限
  //（760×500 / 560×440）出生即超工作区——修复后按 R1W-10 主窗先例（-8 余量）钳制。
  it('R44-15: 小工作区下书架/书库子窗 minWidth/minHeight 按工作区钳制', async () => {
    M.workArea = { width: 600, height: 400 }
    try {
      await freshModule()
      await M.ipcHandle['desktop:open-shelf']!(trustedEvent())
      await new Promise((r) => setImmediate(r))
      const shelf = [...M.windows].reverse().find((w) => w.opts.title === '书架')!
      expect(shelf.opts.minWidth).toBe(592) // Math.min(760, 600-8)——修复前 760
      expect(shelf.opts.minHeight).toBe(392) // Math.min(500, 400-8)——修复前 500
      await M.ipcHandle['desktop:open-library-window']!(trustedEvent())
      await new Promise((r) => setImmediate(r))
      const lib = [...M.windows].reverse().find((w) => w.opts.title === '书库')!
      expect(lib.opts.minWidth).toBe(560) // Math.min(560, 600-8)——大下限不因大工作区放大
      expect(lib.opts.minHeight).toBe(392) // Math.min(440, 400-8)——修复前 440
    } finally {
      M.workArea = { width: 1920, height: 1080 } // 还原共享桩，不污染后续用例
    }
  })

  // R44-17：主进程 uncaughtException → 200ms 后硬退的原语义保留，但窗内对 server
  // child 同步 best-effort 下发 kill（原实现零动作 → win 上孤儿 child 持端口/会话锁
  // 靠 10min 宽限才释放）。注册与 200ms 定时都拦下（真注册 + 真定时 = process.exit
  // 杀死测试进程），只断言行为序列。
  it('R44-17: uncaughtException → 窗内同步 kill server child + 200ms 退出兜底保留', async () => {
    const registered: Record<string, Array<(...a: unknown[]) => void>> = {}
    const onSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(((evt: string | symbol, fn: (...a: unknown[]) => void) => {
        ;(registered[String(evt)] ??= []).push(fn)
        return process
      }) as never)
    // R0910-W：修复后退出改由 stopChild 落定后的 setTimeout(_,0) 触发（不再只靠
    // 200ms 兜底）——真 process.exit 会杀死 vitest worker，mock 掉只断言调用。
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      await freshModule()
      const child = M.forkChildren.at(-1)!
      const killed0 = child.killed
      const handler = registered['uncaughtException']?.at(-1)
      expect(handler).toBeTruthy()
      const timers: number[] = []
      const tSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((_fn: unknown, ms?: number) => {
        timers.push(Number(ms))
        return 0 as unknown as ReturnType<typeof setTimeout>
      }) as never)
      try {
        handler!(new Error('测试崩溃'))
      } finally {
        tSpy.mockRestore()
      }
      await new Promise((r) => setImmediate(r)) // stopChild 链：settle → kill 落拍
      expect(child.killed).toBeGreaterThan(killed0) // kill 已下发（不等回执）
      expect(timers).toContain(200) // 既有 200ms 硬退兜底预算保留
      // 退出由 stopChild 落定后的 setTimeout(_,0) 触发（异步链，宏任务轮询等待）；
      // 必须等到 exitSpy 被调用后再还原——否则迟到的真 process.exit 会杀死 worker
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1), { timeout: 1_000, interval: 10 })
      const crashLogs = M.logErrors.filter((l) => String((l as unknown[])[1]).includes('未捕获异常'))
      expect(crashLogs.length).toBeGreaterThan(0) // JSONL 留痕不丢
    } finally {
      exitSpy.mockRestore()
      onSpy.mockRestore()
    }
  })

  // R0912-3（重评-0912 P3 #35）：stopChild 慢于 200ms backstop（自动重启 fork 握手挂起
  // = 'pending' 形态，settle 预算 2s 远未到）时，修复前 backstop 到点裸退、kill 从未
  // 发出成孤儿——修复后 backstop 内先经 killNow 同步发 kill 再 process.exit(1)，退出
  // 不被 stopChild 拖延。真 200ms 定时器驱动（process.exit 已 mock）。
  it('R0912-3 #35: stopChild 慢于 backstop → killNow 仍发出 kill，退出不被拖延', async () => {
    const registered: Record<string, Array<(...a: unknown[]) => void>> = {}
    const onSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(((evt: string | symbol, fn: (...a: unknown[]) => void) => {
        ;(registered[String(evt)] ??= []).push(fn)
        return process
      }) as never)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      await freshModule()
      const child1 = M.forkChildren.at(-1)!
      const forkCount0 = M.forkChildren.length
      // 崩溃 → backoff[0]=0 自动重启 fork（'pending'：ready 永不到达，握手挂起）
      M.forkBehavior = 'pending'
      child1.emit('exit', 1)
      await vi.waitFor(() => expect(M.forkChildren.length).toBe(forkCount0 + 1), { timeout: 500 })
      const child2 = M.forkChildren.at(-1)!
      const handler = registered['uncaughtException']?.at(-1)
      expect(handler).toBeTruthy()
      const t0 = Date.now()
      handler!(new Error('测试崩溃'))
      // stopChild 的 settle 竞速（2s 预算）未收口，backstop 200ms 到点：killNow 同步
      // 对在途 fork 发 kill → process.exit(1)。两断言都须在 ~200ms 量级达成（修复前
      // killed 不增——kill 被裸退截断；修复后 kill 与退出同拍发出，不被 2s 预算拖延）
      await vi.waitFor(() => expect(child2.killed).toBeGreaterThanOrEqual(1), { timeout: 1_500, interval: 20 })
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(Date.now() - t0).toBeLessThan(1_900)
      // R0916-5d（拆分件迟到弹收口）：pending 形态的 stopChild settle 竞速（2s 预算）
      // 原样泄漏到用例之外——旧 2800 行单文件时代，迟到的 settle 臂 setTimeout(0) 真
      // process.exit 落在同文件后续用例的在役 exit spy 上被吸收；拆分后本件用例稀疏，
      // 迟到弹落空即成全量门 unhandled error（vitest 截获真 process.exit，main.ts:716）。
      // 现于 exit spy 在役窗内放行 ready 握手令 settle 链即刻落定，等到 settle 臂的
      // 退出回调（第 2 次 exit(1)，已 mock）到位后再还原 spy——迟到弹确定性拆除，
      // R0912-3 原竞速断言面不变。
      child2.emit('message', { type: 'ready', port: 45678 })
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledTimes(2), { timeout: 1_500, interval: 10 })
      // P3-21（四轮处置批）：断言后 drain 一拍——stopChild settle 链与迟到的
      // setTimeout(0) 退出回调（exit 已 mock）在本用例窗口内冲刷完毕，不再漏进
      // 后续用例执行中途（child 已 kill，drain 无副作用）。
      await new Promise((r) => setImmediate(r))
    } finally {
      M.forkBehavior = 'ready' // 还原共享桩，不污染后续用例
      exitSpy.mockRestore()
      onSpy.mockRestore()
    }
  })
})

// R0910-W（2026-09-10 修复批）：窗口关闭清理链防炸穿回归——真实 Electron 窗口销毁后
// 读 win.webContents 抛 "Object has been destroyed"（实测）。trustedSenders 摘除监听是
// closed 事件的首个监听，原实现在回调内现读 win.webContents → 抛错中断 emit 遍历，
// 令自愈计时器撤销 / 子窗引用置空 / 主窗 null→app.quit 全部短路，并经 uncaughtException
// 提前硬退（打开书架/书库窗关闭、或点回主窗触发 libraryWindow.close 即可复现）。
describe('R0910-W: 窗口关闭（销毁态 webContents）不炸穿 closed 清理链', () => {
  it('关闭主窗：emit 不外抛、自愈计时器撤销、退出链 app.quit 照跑、IPC 白名单登记摘除', async () => {
    vi.resetModules()
    const mod = (await import('../../src/desktop/main.js')) as unknown as {
      __testHooks: { trustedSenderCount: () => number; hasTrustedSender: (wc: unknown) => boolean }
    }
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const win = M.windows.at(-1)!
    const wc = win._wc as Record<string, any>
    M.throwWebContentsOnDestroyed = true // 复刻真实 Electron 销毁后读 webContents 抛错
    const tSpy = vi.spyOn(globalThis, 'setTimeout')
    const cSpy = vi.spyOn(globalThis, 'clearTimeout')
    const quit0 = M.quitCalls
    try {
      expect(mod.__testHooks.hasTrustedSender(wc)).toBe(true) // 建窗即登记
      // 武装自愈稳定窗计时器——closed 清理应撤销它（计数复位防 5min 滞留）
      ;(wc.handlers['did-finish-load'] ?? []).forEach((fn: () => void) => fn())
      const stabilityTimer = tSpy.mock.results.at(-1)?.value
      expect(stabilityTimer, 'did-finish-load 应排定稳定窗计时器').toBeTruthy()
      expect(() => win.close()).not.toThrow() // (i) 关窗 emit 不外抛
      expect(cSpy).toHaveBeenCalledWith(stabilityTimer) // (ii) 自愈计时器已撤销
      expect(M.quitCalls).toBe(quit0 + 1) // (ii) 主窗 closed → app.quit 退出链照跑
      expect(mod.__testHooks.hasTrustedSender(wc)).toBe(false) // (iii) 白名单登记已摘除
    } finally {
      tSpy.mockRestore()
      cSpy.mockRestore()
      M.throwWebContentsOnDestroyed = false // 还原共享桩，不污染后续用例
    }
  })
})

// R0910-W（2026-09-10 修复批）：窗口循环冒烟 env 门的单元契约——门开时复用
// createSecureWindow 真链（建窗→about:blank→关闭→白名单摘除→契约串→app.exit(0)）；
// 门关时严格零副作用（不建窗/不打串/不改时序）。真实 Electron 进程面兜底见
// src/desktop/main.ts runSmokeWindowCycle（CI 驱动跑真 Electron 进程 grep 契约串）。
describe('R0910-W: 窗口循环冒烟门（CLW_SMOKE_WINDOW_CYCLE）', () => {
  function flushBootstrap(): Promise<void> {
    return new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)))
  }

  it('env 未设：bootstrap 只开主窗、无 window-cycle 串、无 app.exit（严格 opt-in）', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubEnv('CLW_SMOKE_WINDOW_CYCLE', '')
    try {
      const windows0 = M.windows.length
      const exits0 = M.exitCodes.length
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await flushBootstrap()
      await new Promise((r) => setTimeout(r, 50)) // 越过冒烟校验延迟窗，确认无迟到动作
      expect(M.windows.length).toBe(windows0 + 1) // 仅主窗，无冒烟探针窗
      expect(M.exitCodes.length).toBe(exits0) // 未触发退出
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('window-cycle'))).toBe(false)
    } finally {
      logSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('env=1：复用工厂建窗→关闭→白名单摘除→打 window-cycle-ok 且 app.exit(0)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubEnv('CLW_SMOKE_WINDOW_CYCLE', '1')
    try {
      const windows0 = M.windows.length
      const exits0 = M.exitCodes.length
      vi.resetModules()
      const mod = (await import('../../src/desktop/main.js')) as unknown as {
        __testHooks: { trustedSenderCount: () => number }
      }
      await flushBootstrap()
      // 探针窗经 createSecureWindow 创建（主窗之外），关闭后仍留在捕获数组
      await vi.waitFor(() => expect(M.windows.length).toBe(windows0 + 2), { timeout: 2_000, interval: 25 })
      await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith('[CLW_SMOKE] window-cycle-ok'), {
        timeout: 2_000,
        interval: 25,
      })
      expect(M.exitCodes.slice(exits0)).toEqual([0]) // 成功 exit 0
      expect(mod.__testHooks.trustedSenderCount()).toBe(1) // 探针窗白名单登记已摘除，仅余主窗
      expect(logSpy.mock.calls.some((c) => String(c[0]).startsWith('[CLW_SMOKE] crash'))).toBe(false)
    } finally {
      logSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})
