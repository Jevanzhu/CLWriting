/**
 * R0916-5b（2026-09-16）：main.test.ts（kk-P2-8 主进程自动化，2800 行）按 describe
 * 域拆分件之一——「关窗/退出兜底 flush 族」域：R44-2（close 拦截 + flush 钩子 + 冲突
 * 确认）+ R49-5（close/quit flush 链互斥）+ 重评-1（failed 消费：留痕 + 原生确认）+
 * R51-A-1（relaunch 武装时机，取消无后效）。
 * 用例自原文件 1421-1947 行整块原样搬移（describe/test 名称、断言、mock 行为零变化）；
 * mock 工厂/装置见 ./main-fixtures.js，④批 P2 监听器治理 harness 见
 * ./main-process-harness.js（R0915-P2 承重墙，逐件复刻）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  M,
  mkTmp,
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

let libA: string

beforeAll(async () => {
  libA = await bootstrapMainFixture()
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

// ── R44-2（四十四轮）：关窗/退出兜底——主进程拦截 + 渲染层异步 flush ──────────────
// 契约：Chromium ≥M80 在卸载路径整体禁同步 XHR（渲染层同步兜底实证零字节到达），
// 改主进程 close/before-quit 拦截 → executeJavaScript 调渲染层钩子 → 落定/超时后
// destroy 直关；冲突未决弹原生确认可取消。fresh module 手法同 kk-P2-8。
describe('R44-2: 关窗/退出兜底（close 拦截 + flush 钩子 + 冲突确认）', () => {
  async function freshModule(): Promise<(typeof M.windows)[number]> {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    return M.windows.at(-1)!
  }

  it('close 首轮拦截 → 渲染层钩子 flush → destroy 直关（不再触发 beforeunload）', async () => {
    const win = await freshModule()
    win.webContents.execJsResult = { conflict: [], failed: [] }
    const e = { preventDefault: vi.fn() }
    win.emit('close', e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1) // 修复点：拦下等 flush
    await new Promise((r) => setImmediate(r))
    expect(win.webContents.execJs).toHaveLength(1)
    expect(win.webContents.execJs[0]).toContain('__clwFlushBeforeClose')
    expect(win.isDestroyed()).toBe(true) // flush 落定后 destroy 收口
  })

  it('close + 冲突未决 + 作者取消 → 不 destroy 可再关；确认放弃 → destroy', async () => {
    const win = await freshModule()
    win.webContents.execJsResult = { conflict: ['d1'], failed: [] }
    const box0 = M.msgBoxSync.length
    M.msgBoxSyncChoice = 1 // 取消
    let e = { preventDefault: vi.fn() }
    win.emit('close', e)
    await new Promise((r) => setImmediate(r))
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(M.msgBoxSync.length).toBe(box0 + 1) // R44-19：原生确认替代无反馈死关窗
    expect(String(M.msgBoxSync.at(-1)!.message)).toContain('保存冲突')
    expect(win.isDestroyed()).toBe(false) // 取消：窗口保留
    M.msgBoxSyncChoice = 0 // 放弃修改并继续
    e = { preventDefault: vi.fn() }
    win.emit('close', e)
    await new Promise((r) => setImmediate(r))
    expect(win.isDestroyed()).toBe(true)
  })

  it('close + 渲染层无钩子（execJsResult=null）→ 零等待直关', async () => {
    const win = await freshModule()
    win.webContents.execJsResult = null
    const e = { preventDefault: vi.fn() }
    win.emit('close', e)
    await new Promise((r) => setImmediate(r))
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.isDestroyed()).toBe(true) // 无 dirty 可救：不拖关窗
  })

  it('session-end 后 close 放行直关（OS 收尾窗口不白等 flush）；session-end 本身已并行下发尽力 flush（R53-A-1）', async () => {
    const win = await freshModule()
    win.emit('session-end', {})
    const e = { preventDefault: vi.fn() }
    win.emit('close', e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    // R53-A-1：session-end 处理器内并行 flush 已下发（executeJavaScript 调渲染层钩子），
    // close 直关放行语义不变（不等待该 flush）
    expect(win.webContents.execJs).toHaveLength(1)
    expect(win.webContents.execJs[0]).toContain('__clwFlushBeforeClose')
    await new Promise((r) => setImmediate(r))
    expect(M.logInfos.some((l) => String((l as unknown[])[1]).includes('session-end 渲染层 flush'))).toBe(true)
  })

  // R1010-P3（G7-⑦）：session-end 在途的级联 quit（主窗 closed → app.quit()）直通——
  // OS 收尾期 quit 链不再起交互链：flush 打向已死 server 必落空、conflict/failed 的
  // 原生同步确认无人可答（同步对话框会把进程钉死在 OS 收尾窗口内）。
  it('R1010-P3 G7-⑦: session-end 后级联 quit 直通——不 preventDefault、零弹窗、不另起 flush', async () => {
    const win = await freshModule()
    win.webContents.execJsResult = { conflict: ['d1'], failed: ['d2'] }
    const boxSync0 = M.msgBoxSync.length
    const boxAsync0 = M.msgBox.length
    win.emit('session-end', {})
    await new Promise((r) => setImmediate(r)) // session-end 并行 flush 落定
    const exec0 = win.webContents.execJs.length
    const e = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e)
    expect(e.preventDefault).not.toHaveBeenCalled() // 直通：不再起交互链
    expect(M.msgBoxSync.length).toBe(boxSync0) // 零同步确认（无人可答）
    expect(M.msgBox.length).toBe(boxAsync0)
    expect(win.webContents.execJs.length).toBe(exec0) // quit 链不另起 flush
    expect(M.logInfos.some((l) => String((l as unknown[])[1]).includes('session-end 在途的级联 quit'))).toBe(true)
  })

  // R1010b-DSK-P2-1（2026-09-10 内存专项重审修复批）：close 链 flush 落定后的停机复查
  // ——首行闸只护「close 到达时旗已置位」，护不住「close 先到 → flush 在途 → session-end
  // 后置」竞窗：flush 落定后同步确认框会在 OS 会话收尾有限窗口内弹出，进程被钉死到强杀。
  it('R1010b-DSK-P2-1: close flush 在途时 session-end 置旗 → flush 落定跳过同步确认直接关窗 + warn 留痕', async () => {
    const win = await freshModule()
    // flush 挂手动闸（模拟竞窗：红叉先到、flush 未落定，session-end 随后置旗）
    let release!: (v: unknown) => void
    const gate = new Promise((r) => {
      release = r
    })
    win.webContents.executeJavaScript = (code: string) => {
      win.webContents.execJs.push(code)
      return gate
    }
    const box0 = M.msgBoxSync.length
    const warn0 = M.logWarns.length
    // 1) close 先到：拦下等 flush（在途窗口）
    const e1 = { preventDefault: vi.fn() }
    win.emit('close', e1)
    expect(e1.preventDefault).toHaveBeenCalledTimes(1)
    await new Promise((r) => setImmediate(r))
    expect(win.webContents.execJs).toHaveLength(1)
    // 2) OS 关机竞入：session-end 置旗（并行 flush 同闸挂起 + 停机指令照发）
    win.emit('session-end')
    await new Promise((r) => setImmediate(r))
    // 3) flush 落定（conflict/failed 非空）→ 跳过两个同步确认直接 destroy 收口
    release({ conflict: ['d1'], failed: ['d2'] })
    await new Promise((r) => setImmediate(r))
    expect(M.msgBoxSync.length).toBe(box0) // 修复点：停机窗口内零同步确认（进程不被钉死）
    expect(win.isDestroyed()).toBe(true) // 留痕后照常关窗收口
    expect(
      M.logWarns.slice(warn0).some((l) => String((l as unknown[])[1]).includes('跳过冲突/失败确认')),
    ).toBe(true)
  })

  // RC 源码重审 A-1（Opus-5.5 轮）：session-end 链改序——先等渲染层 flush 落定再下发停机
  // 指令。旧「并行下发互不等待」下，渲染层 PUT 几乎必然晚于子进程停机指令，而
  // shutdownStudio 逐书 abort 后立即 server.close()：迟到的保存连连接都进不来（本文件
  // 反面用例即钉这条），失败只落 info 日志——自动保存节拍内的最后键入静默丢失。
  describe('RC 源码重审 A-1: session-end 先落 flush 再停服', () => {
    it('flush 在途时不得先行下发停机指令；落定后才停服', async () => {
      const win = await freshModule()
      const child = M.forkChildren.at(-1)!
      // flush 挂手动闸（渲染层往返未落定）
      let release!: (v: unknown) => void
      const gate = new Promise((r) => {
        release = r
      })
      win.webContents.executeJavaScript = (code: string) => {
        win.webContents.execJs.push(code)
        return gate
      }
      win.emit('session-end')
      await new Promise((r) => setImmediate(r))
      expect(win.webContents.execJs).toHaveLength(1)
      // 关键断言：flush 未落定 → 停机指令不得下发（停服后保存必失败，正是要修的破面）
      expect(child.posted).not.toContainEqual({ type: 'shutdown' })
      // 落定即停服（不等满预算）
      release({ conflict: [], failed: [] })
      await vi.waitFor(() => expect(child.posted).toContainEqual({ type: 'shutdown' }))
    })

    it('窗口已先销毁（flush 链早退分支）→ 停机指令仍下发（finally 兜底）', async () => {
      const win = await freshModule()
      const child = M.forkChildren.at(-1)!
      win.destroy() // 早退分支：target.isDestroyed() 命中（flush 链不发起 executeJavaScript）
      win.emit('session-end')
      await vi.waitFor(() => expect(child.posted).toContainEqual({ type: 'shutdown' }))
      expect(win.webContents.execJs).toHaveLength(0) // 窗已销毁：不白起 flush
    })

    it('渲染层挂起 → 预算到点后仍下发停机指令（等待有界，不拖死 OS 收尾）', async () => {
      const prevBudget = process.env['CLW_SESSION_END_FLUSH_BUDGET_MS']
      process.env['CLW_SESSION_END_FLUSH_BUDGET_MS'] = '500'
      try {
        vi.useFakeTimers()
        vi.resetModules()
        await import('../../src/desktop/main.js')
        await vi.advanceTimersByTimeAsync(0)
        const win = M.windows.at(-1)!
        const child = M.forkChildren.at(-1)!
        win.webContents.executeJavaScript = (code: string) => {
          win.webContents.execJs.push(code)
          return new Promise(() => {}) // 永不落定
        }
        win.emit('session-end')
        await vi.advanceTimersByTimeAsync(0)
        expect(child.posted).not.toContainEqual({ type: 'shutdown' }) // 预算内仍在等
        await vi.advanceTimersByTimeAsync(500) // 预算到点
        expect(child.posted).toContainEqual({ type: 'shutdown' }) // 有界收口：仍下发停机
        expect(M.logInfos.some((l) => String((l as unknown[])[1]).includes('session-end 渲染层 flush 未落定'))).toBe(true)
      } finally {
        vi.useRealTimers()
        if (prevBudget === undefined) delete process.env['CLW_SESSION_END_FLUSH_BUDGET_MS']
        else process.env['CLW_SESSION_END_FLUSH_BUDGET_MS'] = prevBudget
      }
    })
  })

  // R53-A-1（五十三轮）：session-end 并行 flush 的三种结局——落净 / 未落净（冲突+失败
  // 只留痕不弹窗）/ 钩子缺失。停机窗口内原生确认框会钉死进程，conflict/failed 只能留痕。
  it('R53-A-1: session-end flush 落净 → info 留痕；未落净（冲突/失败）→ error 留痕零弹窗', async () => {
    const win = await freshModule()
    win.webContents.execJsResult = { conflict: ['d1'], failed: ['d2'] }
    const box0 = M.msgBoxSync.length
    const err0 = M.logErrors.length
    win.emit('session-end')
    await new Promise((r) => setImmediate(r))
    expect(M.msgBoxSync.length).toBe(box0) // 停机窗口内不弹原生确认（无人可答）
    const sessionErrs = M.logErrors.slice(err0).filter((l) => String((l as unknown[])[1]).includes('session-end 渲染层 flush 落定但未落净'))
    expect(sessionErrs.length).toBe(1)
    expect(String((sessionErrs[0] as unknown[])[1])).toContain('冲突 1 个')
    expect(String((sessionErrs[0] as unknown[])[1])).toContain('保存失败 1 个')

    const win2 = await freshModule()
    win2.webContents.execJsResult = { conflict: [], failed: [] }
    win2.emit('session-end')
    await new Promise((r) => setImmediate(r))
    expect(M.logInfos.some((l) => String((l as unknown[])[1]).includes('session-end 渲染层 flush 落净'))).toBe(true)
  })

  it('R53-A-1: session-end 渲染层挂起 → 短预算到点放弃（不拖停机；预算可注入快进）', async () => {
    const prevBudget = process.env['CLW_SESSION_END_FLUSH_BUDGET_MS']
    process.env['CLW_SESSION_END_FLUSH_BUDGET_MS'] = '500'
    try {
      // fake timers 下自建模块（对齐 R50-A-1 用法：freshModule 的 setImmediate 等待
      // 会被 fake timers 冻结，不可用）；预算经 env 注入（模块级常量，import 前设好）
      vi.useFakeTimers()
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await vi.advanceTimersByTimeAsync(0) // bootstrap + 首窗落定
      const win = M.windows.at(-1)!
      // flush 挂在手动闸上（模拟渲染层挂起：executeJavaScript 永不 resolve 直至放行）
      let release!: (v: unknown) => void
      const gate = new Promise((r) => {
        release = r
      })
      win.webContents.executeJavaScript = (code: string) => {
        win.webContents.execJs.push(code)
        return gate
      }
      const info0 = M.logInfos.length
      win.emit('session-end')
      await vi.advanceTimersByTimeAsync(0) // flush 链进入 race（闸未放）
      expect(win.webContents.execJs).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(500) // 预算到点：放弃等待（不拖停机）
      expect(M.logInfos.length).toBeGreaterThan(info0)
      expect(M.logInfos.some((l) => String((l as unknown[])[1]).includes('session-end 渲染层 flush 未落定'))).toBe(true)
      release({ conflict: [], failed: [] }) // 收尾放闸（防悬挂句柄）
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
      if (prevBudget === undefined) delete process.env['CLW_SESSION_END_FLUSH_BUDGET_MS']
      else process.env['CLW_SESSION_END_FLUSH_BUDGET_MS'] = prevBudget
    }
  })

  // R50-A-1（五十轮）：win 取消关机自愈——session-end 置旗 + shutdown 后，观察窗
  // 到点进程仍存活 = OS 收尾没带走进程（关机被取消/被拒）→ sessionEnding 复位
  // （close 重走 flush 拦截，编辑不静默丢失）+ server 钉住首启端口拉回（origin 不变）。
  // fake timers 快进观察窗；时长经 CLW_SESSION_END_RECOVERY_MS 注入（beforeAll 文件级
  // 抬 1h 关掉其他用例的陈旧观察窗，本用例自带小值覆盖）。
  it('R50-A-1: session-end 观察窗到点（关机被取消）→ 复位直关旗 + server 钉住端口恢复', async () => {
    const prevRecovery = process.env['CLW_SESSION_END_RECOVERY_MS']
    process.env['CLW_SESSION_END_RECOVERY_MS'] = '5000'
    try {
      vi.useFakeTimers()
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await vi.advanceTimersByTimeAsync(0) // bootstrap + 首个 child ready 落定
      const win = M.windows.at(-1)!
      const child = M.forkChildren.at(-1)!
      win.emit('session-end')
      // 窗口内旧语义不回归：close 直关放行（不拦不等 flush）+ 停机指令已下发收口；
      // R53-A-1：session-end 处理器内并行 flush 已先此下发（execJs 1 条）
      const e1 = { preventDefault: vi.fn() }
      win.emit('close', e1)
      expect(e1.preventDefault).not.toHaveBeenCalled()
      expect(win.webContents.execJs).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(0) // mock child 自动回执 shutdown-done + exit
      expect(child.posted).toContainEqual({ type: 'shutdown' })
      // 观察窗到点：sessionEnding 复位 + server 拉回（fork+1，--port 钉住首启端口）
      const forks0 = M.forkChildren.length
      await vi.advanceTimersByTimeAsync(5_000)
      expect(M.forkChildren.length).toBe(forks0 + 1)
      const forkArgs = M.forkCalls.at(-1)!.args
      expect(forkArgs[forkArgs.indexOf('--port') + 1]).toBe('45678') // S-1 钉住端口（前端 origin 不动）
      // 复位后 close 不再直关：拦下走渲染层 flush（「编辑永不静默丢失」红线恢复）
      win.webContents.execJsResult = { conflict: [], failed: [] }
      const e2 = { preventDefault: vi.fn() }
      win.emit('close', e2)
      expect(e2.preventDefault).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(win.webContents.execJs.length).toBeGreaterThanOrEqual(1)
      expect(win.isDestroyed()).toBe(true) // flush 落定 destroy 收口
    } finally {
      vi.useRealTimers()
      if (prevRecovery === undefined) delete process.env['CLW_SESSION_END_RECOVERY_MS']
      else process.env['CLW_SESSION_END_RECOVERY_MS'] = prevRecovery
    }
  })

  it('before-quit：flush 先于 shutdown（先存后停服）；收口 destroy 全窗', async () => {
    const quit0 = M.quitCalls
    const win = await freshModule()
    win.webContents.execJsResult = { conflict: [], failed: [] }
    const child = M.forkChildren.at(-1)!
    const e = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 1))
    // 修复点：渲染层 flush 已先于 server shutdown 发生（顺序敏感——停服后保存必失败）
    expect(win.webContents.execJs.length).toBeGreaterThanOrEqual(1)
    expect(child.posted).toContainEqual({ type: 'shutdown' })
    expect(win.isDestroyed()).toBe(true) // 收口 destroy 直关（不走渲染层 beforeunload）
  })

  it('before-quit + 冲突未决 + 取消 → 不停服不退出；二次 quit 重走 flush 可再确认', async () => {
    const quit0 = M.quitCalls
    const win = await freshModule()
    win.webContents.execJsResult = { conflict: ['d1'], failed: [] }
    const child = M.forkChildren.at(-1)!
    M.msgBoxSyncChoice = 1 // 取消退出
    const e1 = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e1)
    await new Promise((r) => setImmediate(r))
    expect(e1.preventDefault).toHaveBeenCalledTimes(1)
    expect(child.posted).not.toContainEqual({ type: 'shutdown' }) // 未 beginShutdown
    expect(M.quitCalls).toBe(quit0)
    expect(win.isDestroyed()).toBe(false)
    // 二次 quit：flush 闸已复位 → 重走完整链，确认放弃后正常退出
    M.msgBoxSyncChoice = 0
    const e2 = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e2)
    await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 1))
    expect(child.posted).toContainEqual({ type: 'shutdown' })
  })
})

// ── R49-5（评审四十九轮）：close/quit 两 flush 链互斥——同窗不双 executeJavaScript ──
// closeFlushInFlight（close 链）与 quitFlushInFlight（before-quit 链）原互不感知：
// close flush 在途时 Cmd+Q 会对同窗再起一次 flush（双 executeJavaScript、极端时序
// 双确认框）。修复后两链入口互查对方在途旗，只拦不起第二链；close 链在途时到达的
// 退出请求由 close 链收尾统一汇入 app.quit()（destroy 后补发，不丢 flush）。
describe('R49-5: close/quit flush 链互斥', () => {
  async function freshModule(): Promise<(typeof M.windows)[number]> {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    return M.windows.at(-1)!
  }

  /** 让 flush 停在在途（两链竞争窗）：executeJavaScript 挂在手动闸上，返回放行函数 */
  function gateFlush(win: (typeof M.windows)[number]): () => void {
    let release!: (v: unknown) => void
    const gate = new Promise((r) => {
      release = r
    })
    win.webContents.executeJavaScript = (code: string) => {
      win.webContents.execJs.push(code)
      return gate
    }
    return () => release({ conflict: [], failed: [] })
  }

  it('close flush 在途时 before-quit → 只拦不起第二链（单次 executeJavaScript）；close 链收尾汇入 quit', async () => {
    const quit0 = M.quitCalls
    const win = await freshModule()
    const child = M.forkChildren.at(-1)!
    const releaseFlush = gateFlush(win)
    // 1) close 链先行：拦截 + flush 挂起（在途窗口）
    const e1 = { preventDefault: vi.fn() }
    win.emit('close', e1)
    expect(e1.preventDefault).toHaveBeenCalledTimes(1)
    await new Promise((r) => setImmediate(r))
    expect(win.webContents.execJs).toHaveLength(1)
    // 2) close flush 在途时 Cmd+Q：只拦不第二链（修复前此处会对同窗再起一链）
    const e2 = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e2)
    expect(e2.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.webContents.execJs).toHaveLength(1) // 仍单次 flush
    expect(M.quitCalls).toBe(quit0) // 不放行退出（在途 flush 未落定）
    // 3) flush 落定 → close 链 destroy 收尾 → 待汇入退出请求补发 app.quit()
    releaseFlush()
    await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 1))
    expect(win.isDestroyed()).toBe(true)
    // 4) 补发 quit 再进 before-quit（Electron 语义）：窗已毁不再 flush（仍单次），走
    //    正常停机链收口（汇入路径 = 正常退出链，非第二 flush 链）
    const e3 = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e3)
    expect(win.webContents.execJs).toHaveLength(1) // 汇入链不重复 flush
    await vi.waitFor(() => expect(child.posted).toContainEqual({ type: 'shutdown' }))
    await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 2))
  })

  it('close flush 在途时 before-quit + 冲突取消 → 待汇入退出请求一并作废（应用原样保留，旗复位可再关）', async () => {
    const quit0 = M.quitCalls
    const win = await freshModule()
    let release!: (v: unknown) => void
    const gate = new Promise((r) => {
      release = r
    })
    win.webContents.executeJavaScript = (code: string) => {
      win.webContents.execJs.push(code)
      return gate
    }
    M.msgBoxSyncChoice = 1 // 作者取消
    const box0 = M.msgBoxSync.length
    const e1 = { preventDefault: vi.fn() }
    win.emit('close', e1)
    await new Promise((r) => setImmediate(r))
    const e2 = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e2) // Cmd+Q 撞上 close flush 在途
    release({ conflict: ['d1'], failed: [] })
    await new Promise((r) => setImmediate(r))
    // 原生确认弹一次（非双确认框）+ 作者取消 → 窗口保留、不退出
    expect(M.msgBoxSync.length).toBe(box0 + 1)
    expect(win.isDestroyed()).toBe(false)
    expect(M.quitCalls).toBe(quit0)
    // 旗已复位：可再正常关（重走完整链），不因在途旗卡死（劫持通道仍在——闸已决，
    // 冲突载荷回放，确认改选「放弃修改并继续」放行 destroy）
    M.msgBoxSyncChoice = 0
    const e3 = { preventDefault: vi.fn() }
    win.emit('close', e3)
    expect(e3.preventDefault).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(win.isDestroyed()).toBe(true))
    expect(win.webContents.execJs.length).toBe(2) // 第二链正常发起（未被在途旗拦死）
  })

  it('quit flush 在途时 close → 只拦不起第二链；quit 链收口统一 destroy 全窗', async () => {
    const quit0 = M.quitCalls
    const win = await freshModule()
    const child = M.forkChildren.at(-1)!
    const releaseFlush = gateFlush(win)
    // quit 链先行：flush 挂起（在途窗口）
    const e1 = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e1)
    await new Promise((r) => setImmediate(r))
    expect(win.webContents.execJs).toHaveLength(1)
    // close 事件撞上 quit flush 在途：只拦不第二链（修复前会再起一链双 flush）
    const e2 = { preventDefault: vi.fn() }
    win.emit('close', e2)
    expect(e2.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.webContents.execJs).toHaveLength(1)
    // flush 落定 → quit 链收口：shutdown → destroy 全窗 → quit（close 拦下不丢链）
    releaseFlush()
    await vi.waitFor(() => expect(child.posted).toContainEqual({ type: 'shutdown' }))
    await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 1))
    expect(win.isDestroyed()).toBe(true)
  })
})

// ── 重评-1（全库代码重评审 2026-09-05）：关窗/退出兜底 failed 消费 ────────────────
// flush 钩子返回 { conflict, failed }（failed = 保存失败的 docId 列表，产出面
// web-next stores/doc.ts flushBeforeClose），主进程原实现只判 conflict：failed 零
// 消费 → 保存失败恰逢关窗/退出时编辑增量静默丢失，违背「编辑永不静默丢失」红线。
// 修复后 close/quit 两链先留痕失败清单再弹原生确认（confirmDiscardFailed），取消 =
// 应用原样保留。fresh module 手法与 mock 基建同 R44-2/R49-5。
describe('重评-1: 关窗/退出兜底 failed（保存失败）消费——留痕 + 原生确认', () => {
  async function freshModule(): Promise<(typeof M.windows)[number]> {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    return M.windows.at(-1)!
  }

  it('close 链 failed 非空 → error 留痕含 docId 清单 + 原生确认（message 含「保存失败」）；确认放弃 → destroy 收口', async () => {
    const win = await freshModule()
    win.webContents.execJsResult = { conflict: [], failed: ['doc-1', 'doc-2'] }
    M.msgBoxSyncChoice = 0 // 放弃修改并继续
    const box0 = M.msgBoxSync.length
    const err0 = M.logErrors.length
    const e = { preventDefault: vi.fn() }
    win.emit('close', e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1) // 拦下等 flush
    await new Promise((r) => setImmediate(r))
    // failed 非空必弹原生确认（修复前零消费直关 = 静默丢失）
    expect(M.msgBoxSync.length).toBe(box0 + 1)
    const box = M.msgBoxSync.at(-1)!
    expect(String(box.message)).toContain('保存失败') // 文案区别于「保存冲突」
    expect(String(box.message)).toContain('2') // 计数入文案
    expect(box.buttons).toEqual(['放弃修改并继续', '取消'])
    expect(box.defaultId).toBe(1)
    expect(box.cancelId).toBe(1)
    // 留痕：error 日志带 failed docId 清单（文档 id 非敏感，供诊断）
    const failLogs = M.logErrors.slice(err0).filter((l) => String((l as unknown[])[1]).includes('doc-1'))
    expect(failLogs.length).toBeGreaterThanOrEqual(1)
    expect(String((failLogs[0] as unknown[])[1])).toContain('doc-2')
    expect(win.isDestroyed()).toBe(true) // 确认放弃 → destroy 收口
  })

  it('close 链 failed 非空 + 取消 → 窗口保留、在途旗复位（二次 close 重走完整链）', async () => {
    const win = await freshModule()
    win.webContents.execJsResult = { conflict: [], failed: ['doc-1'] }
    M.msgBoxSyncChoice = 1 // 取消
    const e1 = { preventDefault: vi.fn() }
    win.emit('close', e1)
    await new Promise((r) => setImmediate(r))
    expect(M.msgBoxSync.at(-1)!.message).toContain('保存失败')
    expect(win.isDestroyed()).toBe(false) // 取消：窗口原样保留
    // 在途旗已复位：二次 close 重走完整链（若旗未复位，此处只被拦不起第二链）
    M.msgBoxSyncChoice = 0
    const e2 = { preventDefault: vi.fn() }
    win.emit('close', e2)
    expect(e2.preventDefault).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(win.isDestroyed()).toBe(true))
    expect(win.webContents.execJs.length).toBe(2) // 第二链正常发起（旗复位锚点）
  })

  it('quit 链 failed 非空：取消 → 不停机不退出（shutdown 未下发）；确认放弃 → 正常退出收口', async () => {
    const quit0 = M.quitCalls
    const win = await freshModule()
    const child = M.forkChildren.at(-1)!
    win.webContents.execJsResult = { conflict: [], failed: ['doc-1'] }
    M.msgBoxSyncChoice = 1 // 取消退出
    const e1 = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e1)
    await new Promise((r) => setImmediate(r))
    expect(e1.preventDefault).toHaveBeenCalledTimes(1)
    expect(M.msgBoxSync.at(-1)!.message).toContain('保存失败') // quit 链同弹保存失败确认
    expect(child.posted).not.toContainEqual({ type: 'shutdown' }) // 未 beginShutdown（不进入停机）
    expect(M.quitCalls).toBe(quit0) // 不退出
    expect(win.isDestroyed()).toBe(false) // 应用原样保留
    // 二次 quit：flush 闸已复位 → 重走完整链，确认放弃后正常退出收口
    M.msgBoxSyncChoice = 0
    const e2 = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e2)
    await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 1))
    expect(child.posted).toContainEqual({ type: 'shutdown' }) // 停机指令照发（先存后停）
    expect(win.isDestroyed()).toBe(true) // 收口 destroy 全窗
  })
})

// ── R51-A-1（五十一轮）：切库重启意图的武装时机——推迟到 before-quit 不可回头点 ──
// 原实现 relaunch() 当场三连（relaunch+releaseSingleInstanceLock+quit 不可回滚），
// flush 确认取消后应用带「已释放锁+已武装重启」续跑（真双开可抢入 + 后续退出变重启）。
describe('R51-A-1: relaunch 武装时机（取消无后效，链通过才武装）', () => {
  async function freshModule(): Promise<(typeof M.windows)[number]> {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    return M.windows.at(-1)!
  }
  function restoreStore(): void {
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: libA, recent: [] }))
  }

  it('flush failed 取消 → 不武装重启不释放锁，意图随取消丢弃（二次退出为普通退出）', async () => {
    const win = await freshModule()
    const child = M.forkChildren.at(-1)!
    const rel0 = M.relaunchCalls
    const lock0 = M.releaseLockCalls
    const quit0 = M.quitCalls
    // 切库（合法待建书库，R41-1 口径）：记意图 + 触发优雅退出，此刻不得武装
    const r = await M.ipcHandle['desktop:switch-library']!(trustedEvent(), mkTmp('clw-r51-a1-lib-'))
    expect(r).toEqual({ ok: true })
    await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 1)) // setTimeout(relaunch,100) 已触发
    expect(M.relaunchCalls).toBe(rel0) // A-1 锚点：不再当场 app.relaunch()
    expect(M.releaseLockCalls).toBe(lock0)
    // flush failed + 取消：应用原样保留（重评-1 语义），意图被丢弃
    win.webContents.execJsResult = { conflict: [], failed: ['doc-1'] }
    M.msgBoxSyncChoice = 1
    const e1 = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e1)
    await new Promise((r2) => setImmediate(r2))
    expect(e1.preventDefault).toHaveBeenCalledTimes(1)
    expect(M.msgBoxSync.at(-1)!.message).toContain('保存失败')
    expect(M.quitCalls).toBe(quit0 + 1) // 不退出
    expect(win.isDestroyed()).toBe(false)
    // 二次 quit 确认放弃后是**普通退出**——不重启、不释放锁（原实现两处 +1，回归红）
    M.msgBoxSyncChoice = 0
    const e2 = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e2)
    await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 2))
    expect(child.posted).toContainEqual({ type: 'shutdown' })
    expect(M.relaunchCalls).toBe(rel0)
    expect(M.releaseLockCalls).toBe(lock0)
    expect(win.isDestroyed()).toBe(true)
    restoreStore()
  })

  it('flush 全过 → 不可回头点武装重启 + 交接释放锁（恰好一次），退出收口保持', async () => {
    const win = await freshModule()
    const rel0 = M.relaunchCalls
    const lock0 = M.releaseLockCalls
    const quit0 = M.quitCalls
    const r = await M.ipcHandle['desktop:switch-library']!(trustedEvent(), mkTmp('clw-r51-a1-ok-'))
    expect(r).toEqual({ ok: true })
    await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 1))
    // flush 无冲突无失败（execJsResult 缺省 null）→ 链直通不可回头点
    const e = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e)
    await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 2))
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(M.relaunchCalls).toBe(rel0 + 1) // 恰好武装一次
    expect(M.releaseLockCalls).toBe(lock0 + 1) // R27-96 交接释放同步兑现
    expect(win.isDestroyed()).toBe(true) // 收口 destroy 全窗
    restoreStore()
  })
})
