/**
 * R0916-5b（2026-09-16）：main.test.ts（kk-P2-8 主进程自动化，2800 行）按 describe
 * 域拆分件之一——「失联卷可达性预探/服务重启广播」域：R54-A-1/A-2（flush 超时留痕 +
 * switch-library 可达性预探，含 R61-B-1 与 重审-1/2/3）+ 重评-P3-11（second-instance
 * --book 失联卷预探）。fs/promises stat 闸（fsPromisesMock）自 ./main-fixtures.js。
 * 用例自原文件 2466-2745 行整块原样搬移（describe/test 名称、断言、mock 行为零变化）；
 * ④批 P2 监听器治理 harness 见 ./main-process-harness.js（R0915-P2 承重墙，逐件复刻）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  M,
  fsPromisesMock,
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

// ── R54-A-1/A-2（五十四轮）：flush 超时留痕 + 切库可达性预探 ──────────────────
// A-1：close/quit 两链 res===null 此前静默 destroy/继续退出——超时态（保存链慢盘/
// server 退避窗）与「无钩子（非编辑页常态）」不可区分且零诊断线索；修复后超时 warn/
// 无钩子 info 留痕（session-end 链 R53-A-1 已有留痕，三链对称）。
// A-2：switch-library 探测面全在主进程同步执行，失联网络卷残留条目一点切换即冻结
// 三窗 UI；修复后 fs/promises stat 异步预探先行（超时契约化拒切，确定性失败交回同步
// 守卫走原契约文案）。
describe('R54-A-1/A-2: flush 超时留痕 + switch-library 可达性预探', () => {
  async function freshModule(): Promise<(typeof M.windows)[number]> {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    return M.windows.at(-1)!
  }

  /** 让 flush 停在在途（超时态）：executeJavaScript 挂在手动闸上 */
  function gateFlush(win: (typeof M.windows)[number]): (v: unknown) => void {
    let release!: (v: unknown) => void
    const gate = new Promise((r) => {
      release = r
    })
    win.webContents.executeJavaScript = (code: string) => {
      win.webContents.execJs.push(code)
      return gate
    }
    return release
  }

  it('R54-A-1: close flush 超时 → warn 留痕后照常 destroy（不再静默）', async () => {
    vi.useFakeTimers()
    try {
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await vi.advanceTimersByTimeAsync(0) // bootstrap + 首窗落定
      const win = M.windows.at(-1)!
      const release = gateFlush(win)
      const warn0 = M.logWarns.length
      const e = { preventDefault: vi.fn() }
      win.emit('close', e)
      await vi.advanceTimersByTimeAsync(0)
      expect(e.preventDefault).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(4_000) // CLOSE_FLUSH_BUDGET_MS 到点
      expect(M.logWarns.length).toBeGreaterThan(warn0)
      expect(M.logWarns.some((l) => String((l as unknown[])[1]).includes('关窗兜底 flush 超时'))).toBe(true)
      expect(win.isDestroyed()).toBe(true) // 留痕不改变语义：超时后照常收口
      release({ conflict: [], failed: [] }) // 收尾放闸（防悬挂句柄）
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('R54-A-1: close flush 无钩子 → info 留痕（与超时态可区分）', async () => {
    const win = await freshModule()
    win.webContents.execJsResult = null
    const info0 = M.logInfos.length
    const e = { preventDefault: vi.fn() }
    win.emit('close', e)
    await new Promise((r) => setImmediate(r))
    expect(win.isDestroyed()).toBe(true)
    expect(M.logInfos.slice(info0).some((l) => String((l as unknown[])[1]).includes('关窗兜底 flush 无钩子'))).toBe(
      true,
    )
  })

  it('R54-A-1: quit flush 超时 → warn 留痕后照常收口退出', async () => {
    vi.useFakeTimers()
    try {
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await vi.advanceTimersByTimeAsync(0)
      const win = M.windows.at(-1)!
      const child = M.forkChildren.at(-1)!
      const release = gateFlush(win)
      const e = { preventDefault: vi.fn() }
      M.appOn['before-quit']!.at(-1)!(e)
      expect(e.preventDefault).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(4_000) // CLOSE_FLUSH_BUDGET_MS 到点
      expect(M.logWarns.some((l) => String((l as unknown[])[1]).includes('退出前 flush 超时'))).toBe(true)
      // 超时不改变退出语义：收口链继续（停机指令下发 → 收口 destroy 全窗）
      await vi.advanceTimersByTimeAsync(200)
      expect(child.posted).toContainEqual({ type: 'shutdown' })
      expect(win.isDestroyed()).toBe(true)
      release({ conflict: [], failed: [] }) // 收尾放闸（防悬挂句柄）
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('R54-A-2: switch-library 失联卷预探超时 → 契约化拒切、不落库不退出', async () => {
    const prev = process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS']
    process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS'] = '150'
    try {
      await freshModule()
      const good = mkTmp('clw-reach-lib-') // 存在的真实目录（stat 本应通过）
      fsPromisesMock.statGate = () => new Promise(() => {}) // 模拟失联卷 stat 挂死
      const r = (await M.ipcHandle['desktop:switch-library']!(trustedEvent(), good)) as { ok: boolean; reason?: string }
      expect(r).toEqual({ ok: false, reason: '目录暂不可达（可能是网络卷无响应或已断开），请稍后重试' })
      const stored = JSON.parse(readFileSync(join(M.userData, 'workdir.json'), 'utf8')) as { current: string }
      expect(stored.current).not.toBe(good) // 拒切不落库（quitCalls 跨用例共享计数，先例 quit 会异步汇入不精确归因，不作断言面）
    } finally {
      fsPromisesMock.statGate = null
      if (prev === undefined) delete process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS']
      else process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS'] = prev
    }
  })

  it('R54-A-2: 预探确定性失败（不存在路径）走原契约文案，不误报网络卷不可达', async () => {
    await freshModule()
    const r = (await M.ipcHandle['desktop:switch-library']!(trustedEvent(), mkTmp('not-a-lib-') + '/不存在')) as {
      ok: boolean
      reason?: string
    }
    expect(r).toEqual({ ok: false, reason: '目录无效或是另一书库的子目录' })
  })

  it('R61-B-1: open-library（pickLibrary）失联卷预探超时 → 原生错误框 + 不落库（与 switch-library 同款防线）', async () => {
    const prev = process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS']
    process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS'] = '150'
    const dialogBase = M.dialogOpen
    try {
      await freshModule()
      const good = mkTmp('clw-pick-reach-') // 真实存在的空目录（同步守卫本可立刻判定非书库——预探必须先于它拦下）
      fsPromisesMock.statGate = () => new Promise(() => {}) // 模拟失联卷 stat 挂死
      let opens = 0
      // 首开返回失联目录，预探超时报错后留在选择循环；次开取消收口（避免 10 次封顶全跑）
      Object.defineProperty(M, 'dialogOpen', {
        configurable: true,
        get: () => (opens++ === 0 ? { canceled: false, filePaths: [good] } : { canceled: true, filePaths: [] }),
      })
      const r = (await M.ipcHandle['desktop:open-library']!(trustedEvent())) as { ok: boolean; canceled?: boolean }
      expect(r).toEqual({ ok: false, canceled: true })
      expect(M.errorBox.some(([, m]) => String(m).includes('暂不可达'))).toBe(true)
      const stored = JSON.parse(readFileSync(join(M.userData, 'workdir.json'), 'utf8')) as { current: string }
      expect(stored.current).not.toBe(good)
    } finally {
      Object.defineProperty(M, 'dialogOpen', { configurable: true, writable: true, value: dialogBase })
      fsPromisesMock.statGate = null
      if (prev === undefined) delete process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS']
      else process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS'] = prev
    }
  })

  // ── 重审-1/2/3（2026-09-07 全量代码重审 §四.1/.2/.3）：bootstrap/三 IPC 失联卷
  // 预探 + 服务重启成功广播（doRestart/restartPinned 两路径）──
  it('重审-1: bootstrap 持久化 current 失联卷 → 预探超时拦下（errorBox + 回落引导页，不冻结）', async () => {
    const prev = process.env['CLW_BOOTSTRAP_PROBE_TIMEOUT_MS']
    process.env['CLW_BOOTSTRAP_PROBE_TIMEOUT_MS'] = '150'
    try {
      const err0 = M.errorBox.length
      const windows0 = M.windows.length
      fsPromisesMock.statGate = () => new Promise(() => {}) // 模拟失联卷 stat 挂死
      vi.resetModules()
      await import('../../src/desktop/main.js')
      // 重评2（2026-09-09 全量重评 GLM-5.3）测试工程 P3-①：原固定 500ms sleep 等
      // 两段预探（current + cwd）各 150ms 超时落定（≈300ms + 启动链开销）——固定值
      // 是竞速赌注（慢机超 500ms 即假红、快机白等），改 vi.waitFor 轮询可观测终态
      //（fresh 窗已开且落 /welcome），预算 2s ≥ 300ms 预探 + 慢机抖动余量。
      // 锚 windows0：只认本用例 fresh 模块新开的窗，防误吃前用例旧窗的 loaded 面。
      await vi.waitFor(
        () => {
          const win = M.windows[windows0]
          expect(win).toBeTruthy()
          expect(win!.loaded[0]).toContain('/welcome') // 不采信失联 current、不跑 findWorkDir 同步爬祖 → 引导页
        },
        { timeout: 2_000, interval: 25 },
      )
      expect(M.errorBox.slice(err0).some(([, m]) => String(m).includes('暂不可达'))).toBe(true)
    } finally {
      fsPromisesMock.statGate = null
      if (prev === undefined) delete process.env['CLW_BOOTSTRAP_PROBE_TIMEOUT_MS']
      else process.env['CLW_BOOTSTRAP_PROBE_TIMEOUT_MS'] = prev
    }
  })

  it('重审-2: show-in-folder/open-book-dir/open-library-dir 失联卷 → 预探拦下（errorBox + 不触 shell）', async () => {
    const prev = process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS']
    process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS'] = '150'
    try {
      await freshModule()
      const err0 = M.errorBox.length
      const show0 = M.shell.show.length
      const open0 = M.shell.open.length
      fsPromisesMock.statGate = () => new Promise(() => {}) // 模拟失联卷 stat 挂死
      await M.ipcHandle['desktop:show-in-folder']!(trustedEvent(), '书A', 'books/a/第1章-开篇.md')
      await M.ipcHandle['desktop:open-book-dir']!(trustedEvent(), '书A')
      await M.ipcHandle['desktop:open-library-dir']!(trustedEvent())
      expect(M.errorBox.length).toBe(err0 + 3) // 三入口各一框（修复前无预探不弹）
      expect(M.errorBox.slice(err0).every(([, m]) => String(m).includes('暂不可达'))).toBe(true)
      expect(M.shell.show.length).toBe(show0) // 未触文件管理器（修复前 readBooks 在活卷上照常放行）
      expect(M.shell.open.length).toBe(open0)
    } finally {
      fsPromisesMock.statGate = null
      if (prev === undefined) delete process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS']
      else process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS'] = prev
    }
  })

  it('重审-3: 崩溃自动重启成功 → 广播 desktop:server-restarted 到主窗（渲染层可即时 resync）', async () => {
    vi.useFakeTimers()
    try {
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await vi.advanceTimersByTimeAsync(0) // bootstrap + 首窗落定
      const win = M.windows.at(-1)!
      const sent0 = win.webContents.sent.length
      ;(M.forkChildren.at(-1) as unknown as { emit: (e: string, c: number) => void }).emit('exit', 1)
      await vi.advanceTimersByTimeAsync(16_000) // 退避 0 → doRestart → 握手 ready → 广播
      expect(win.webContents.sent.slice(sent0)).toContainEqual(['desktop:server-restarted', 45678])
    } finally {
      vi.useRealTimers()
    }
  })

  it('重审-3: session-end 自愈恢复成功 → 同款广播（restartPinned 路径）', async () => {
    const prevRecovery = process.env['CLW_SESSION_END_RECOVERY_MS']
    process.env['CLW_SESSION_END_RECOVERY_MS'] = '5000'
    try {
      vi.useFakeTimers()
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await vi.advanceTimersByTimeAsync(0)
      const win = M.windows.at(-1)!
      const sent0 = win.webContents.sent.length
      win.emit('session-end')
      await vi.advanceTimersByTimeAsync(5_000) // 观察窗到点 → restartPinned 钉住端口拉回 → 广播
      expect(win.webContents.sent.slice(sent0)).toContainEqual(['desktop:server-restarted', 45678])
    } finally {
      vi.useRealTimers()
      if (prevRecovery === undefined) process.env['CLW_SESSION_END_RECOVERY_MS'] = '3600000'
      else process.env['CLW_SESSION_END_RECOVERY_MS'] = prevRecovery
    }
  })
})

// ── 重评-P3-11（2026-09-09 全量代码重评）：second-instance --book 直进链失联卷预探 ──
// resolveInitialBook→readBooks 同步扫书库，书库在失联网络卷时冻主进程数秒（bootstrap
// 重审-1 / switch-library R54-A-2 / show-in-folder 族重审-2 均有 probeDirReachable
// 预探，唯此入口漏）。'unreachable' → log 留痕 + 忽略 book 引用（同族收口口径）。
describe('重评-P3-11: second-instance --book 失联卷预探', () => {
  it('书库失联卷（stat 挂死）→ 预探拦下：warn 留痕 + 无导航（readBooks 同步扫描不执行）', async () => {
    const prev = process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS']
    process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS'] = '150'
    try {
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      const win = M.windows.at(-1)!
      const h = M.appOn['second-instance']!.at(-1)!
      const n0 = win.webContents.sent.length
      const infos0 = M.logInfos.length
      const warns0 = M.logWarns.length
      fsPromisesMock.statGate = () => new Promise(() => {}) // 模拟失联卷 stat 挂死
      h({}, ['electron', '--book', '书A'])
      // 重评2（2026-09-09 全量重评 GLM-5.3）测试工程 P3-①：原固定 500ms sleep 等
      // 150ms 预探超时落定（重审-1 用例同款）——固定值是竞速赌注（慢机超 500ms 即
      // 假红、快机白等），改 vi.waitFor 轮询可观测终态（忽略 --book 的 warn 留痕已
      // 出），预算 2s ≥ 150ms 预探 + 慢机抖动余量。锚 warns0：只认本用例触发的留痕。
      await vi.waitFor(
        () => {
          expect(
            M.logWarns.slice(warns0).some((l) => {
              const m = String((l as unknown[])[1])
              return m.includes('书A') && m.includes('暂不可达')
            }),
          ).toBe(true)
        },
        { timeout: 2_000, interval: 25 },
      )
      expect(win.webContents.sent.length).toBe(n0) // 无导航：预探先于 readBooks 拦下（挂死形态下若漏探，readBooks 读真目录会照常放行导航）
      const line = M.logWarns.at(-1) as unknown[]
      expect(line![0]).toBe('main')
      expect(String(line![1])).toContain('书A') // 留痕含被忽略的 --book 值
      expect(String(line![1])).toContain('暂不可达')
      expect(M.logInfos.length).toBe(infos0) // 与「无此登记书」留痕形态可区分
    } finally {
      fsPromisesMock.statGate = null
      if (prev === undefined) delete process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS']
      else process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS'] = prev
    }
  })
})
