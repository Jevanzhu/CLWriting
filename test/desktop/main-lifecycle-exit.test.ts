/**
 * R0916-5b（2026-09-16）：main.test.ts（kk-P2-8 主进程自动化，2800 行）按 describe
 * 域拆分件之一——「退出与边界分支」域（app 生命周期收口：before-quit 优雅退出/
 * shutdown 指令链、session-end 补存、崩溃风暴封顶、单实例锁、welcome 态、boot-error、
 * 窗口自愈封顶 X-26/S6、打包态 CLW_DEV_UI 防线 R43-26 等）。
 * 用例自原文件 1043-1419 行整块原样搬移（describe/test 名称、断言、mock 行为零变化）；
 * mock 工厂/装置见 ./main-fixtures.js，④批 P2 监听器治理 harness 见
 * ./main-process-harness.js（R0915-P2 承重墙，逐件复刻）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
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

describe('kk-P2-8：退出与边界分支', () => {
  it('before-quit：preventDefault 优雅退出（收口后二次直通）；退出走 shutdown 指令非裸 kill（批 U2）', async () => {
    const h = M.appOn['before-quit']![0]!
    const e1 = { preventDefault: vi.fn() }
    const q0 = M.quitCalls
    h(e1)
    expect(e1.preventDefault).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(M.quitCalls).toBe(q0 + 1)) // 清理完成后再 quit
    // 首个 handler 归首个模块实例，其 active child 即第一个 fake：指令已下发且
    // 优雅回执路径未触发 kill
    expect(M.forkChildren[0]!['posted']).toContainEqual({ type: 'shutdown' })
    expect(M.forkChildren[0]!['killed']).toBe(0)
    const e2 = { preventDefault: vi.fn() }
    h(e2) // 收口 quit 已置 quitViaShutdown（R65-48）→ 放行直通
    expect(e2.preventDefault).not.toHaveBeenCalled()
  })

  // R65-40（总六十五轮）：before-quit 的 shutdown() 可能 reject（child 已死时
  // postMessage/kill 抛错等）——原 `void …finally` 无 catch：rejection 成
  // unhandledRejection。修复后记日志、finally 仍 quit（退出不挂死）。
  it('R65-40: shutdown 抛错（child 已死形态）→ 记日志后仍 quit，无未处理拒绝', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const quit0 = M.quitCalls
      const err0 = M.logErrors.length
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      const child = M.forkChildren.at(-1)!
      // child 已死形态：postMessage 同步抛（async shutdown 内转为 promise reject）
      child.postMessage = () => {
        throw new Error('child 已死：Object has been destroyed')
      }
      const e = { preventDefault: vi.fn() }
      M.appOn['before-quit']!.at(-1)!(e)
      expect(e.preventDefault).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 1)) // 修复前：quit 悬空
      expect(M.logErrors.length).toBeGreaterThan(err0) // 记日志留痕（不再裸 unhandledRejection）
      await new Promise((r) => setImmediate(r))
      expect(unhandled).toEqual([]) // 无未处理拒绝
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  // R65-48（总六十五轮）：优雅停机窗口内的二次 quit 一律 preventDefault——原
  // beginShutdown() 二次返回 false 即直通，3.5s 窗口内第二次退出事件强杀 child
  //（在途 chat/self-heal 的 session/end 落库被打断）；finally 里自己的 quit 放行。
  it('R65-48: 停机窗口内二次 before-quit 拦下不强杀；finally 的收口 quit 放行直通', async () => {
    const quit0 = M.quitCalls
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const child = M.forkChildren.at(-1)!
    // 停在优雅窗口：收到 shutdown 指令但不自动回执（不 shutdown-done/exit）
    child.postMessage = (m: unknown) => {
      child.posted.push(m)
    }
    const h = M.appOn['before-quit']!.at(-1)!
    const e1 = { preventDefault: vi.fn() }
    h(e1)
    expect(e1.preventDefault).toHaveBeenCalledTimes(1)
    await new Promise((r) => setImmediate(r)) // shutdown 微任务链：指令经 postMessage 下发
    expect(child.posted).toContainEqual({ type: 'shutdown' })
    // 窗口内第二次退出请求：拦下（修复前直通 → Electron 退出连带强杀 child）
    const e2 = { preventDefault: vi.fn() }
    h(e2)
    expect(e2.preventDefault).toHaveBeenCalledTimes(1) // R65-48 修复锚点
    expect(child.killed).toBe(0) // child 未被强杀，优雅窗口完整
    // 回执 → shutdown 收口 → finally 统一 app.quit()
    child.emit('message', { type: 'shutdown-done' })
    child.emit('exit', 0)
    await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 1))
    // finally 里那次 quit 再进 before-quit（Electron 语义）——quitViaShutdown 放行
    const e3 = { preventDefault: vi.fn() }
    h(e3)
    expect(e3.preventDefault).not.toHaveBeenCalled()
  })

  // R40-29（四十轮）：session-end（win 关机/注销）此前只停服务不存窗口状态——窗口
  // 位置/尺寸不落盘，下次开窗回默认位。修复后停机前补一次 saveWinState。fresh 模块
  // 复刻 R65-48 手法（此前用例已把首实例的 child 停机消耗掉，postMessage 断言需新 child）。
  it('R40-29: session-end 停机前补存窗口状态（bounds/maximized 落盘），停机指令仍下发', async () => {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const win = M.windows.at(-1)!
    const child = M.forkChildren.at(-1)!
    const fp = join(M.userData, 'window-state.json')
    // 既有 state 文件无 maximized 键——置 true 后 session-end 触发的新写可与之区分
    win.maximized = true
    win.emit('session-end')
    const saved = JSON.parse(readFileSync(fp, 'utf-8')) as { bounds: Record<string, number>; maximized?: boolean }
    expect(saved.maximized).toBe(true) // 本次新写（preset 无此键）
    expect(saved.bounds).toMatchObject({ x: 50, y: 50, width: 1500, height: 900 }) // 恢复的存量 bounds 落盘
    // R1W-9 主语义不回归：停机指令照发（shutdown 指令非裸 kill）
    await vi.waitFor(() => expect(child['posted']).toContainEqual({ type: 'shutdown' }))
  })

  // 重评2-P2-3（2026-09-09 全量重评 GLM-5.3）：quit 链（before-quit）收口 destroy()
  // 全窗不触发 'close'（Electron 语义），close 拦截首行的 saveWinState 由此不达——
  // Cmd+Q / win 菜单退出 / 崩溃风暴对话框退出 / 切库 relaunch 全汇入此链，退出前
  // 窗口几何变更静默丢失。修复 = quit flush IIFE 链首（窗口仍存活、任何 flush/
  // 确认/destroy 之前）补一次 saveWinState。fresh 模块复刻 R65-48/R40-29 手法
  //（新 child 供停机指令断言）。锚定用哨兵几何值而非 maximized 键存在性——上方
  // R40-29 用例已把 maximized:true 写进 state 文件，键存在性在修复前也成立（假绿）。
  it('重评2-P2-3: quit 链（before-quit → flush IIFE）执行后窗口状态已落盘（destroy 前补存），停机/收口主语义不回归', async () => {
    const quit0 = M.quitCalls
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const win = M.windows.at(-1)!
    const child = M.forkChildren.at(-1)!
    const fp = join(M.userData, 'window-state.json')
    // 哨兵几何（FakeWin.getBounds 直读 opts）：quit 链补存的新写必含此值；修复前
    // destroy 不触发 'close'、链内无 saveWinState，文件停在 R40-29 写入形态
    //（x:50/maximized:true）——哨兵缺席即红，不依赖跨用例文件初态。
    win.opts = { ...win.opts, x: 777, y: 88, width: 1600, height: 1000 }
    win.maximized = false
    const e = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1) // 优雅退出链照常拦下
    await vi.waitFor(() => expect(M.quitCalls).toBe(quit0 + 1)) // flush → 停机 → destroy 收口 → 统一 quit
    const saved = JSON.parse(readFileSync(fp, 'utf-8')) as { bounds: Record<string, number>; maximized?: boolean }
    expect(saved.bounds).toMatchObject({ x: 777, y: 88, width: 1600, height: 1000 }) // 修复锚点：quit 链本次新写（哨兵值落盘）
    expect(saved.maximized).toBe(false) // 同锚（R40-29 旧写为 true，可区分）
    expect(win.isDestroyed()).toBe(true) // 链已走到收口 destroy 全窗（补存先于此点）
    // 主语义不回归：停机指令照发（shutdown 指令非裸 kill）
    expect(child['posted']).toContainEqual({ type: 'shutdown' })
  })

  // 0918二轮修复批（C107）：重复信号硬退出口——SIGINT/SIGBREAK/SIGTERM 注册后 Node
  // 默认退出取消，重复信号被 quit 链幂等门（quitViaShutdown/beginShutdown）吸收，
  // 优雅链最坏 ~10s 内二次 Ctrl+C 无效。修复 = 信号响应逻辑抽 signal-hard-exit.ts
  //（单元测试见 test/desktop/repeated-signal-hard-exit.test.ts），main.ts 三行接线；
  // 同型第二次直接 killNow + exit(1)（「先 kill 再硬退」对齐 uncaughtException 处理器
  // R0912-3 #35 口径，防 utilityProcess 孤儿）。process.on spy 捕获直驱 + process.exit
  // mock（真退会杀 worker），先例 R44-17（main-window-resilience.test.ts）。
  it('C107（0918二轮修复批）：同型信号第二次 → killNow + exit(1) 硬退；首次仍走 app.quit 优雅链', async () => {
    const registered: Record<string, Array<(...a: unknown[]) => void>> = {}
    const onSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(((evt: string | symbol, fn: (...a: unknown[]) => void) => {
        ;(registered[String(evt)] ??= []).push(fn)
        return process
      }) as never)
    // 真 exit 会杀死 vitest worker——mock 掉只断言调用（R44-17 手法）
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      const handlers = registered['SIGINT'] ?? []
      // main.ts 接线形态 `() => onExitSignal('SIGINT')`——零参箭头；uncaughtException
      // 等处理器带参，按 fn.length 分流锁定信号处理器
      const h = handlers.find((f) => f.length === 0)
      expect(h, 'main.ts 应注册零参 SIGINT 处理器').toBeTruthy()
      const child = M.forkChildren.at(-1)!
      const quit0 = M.quitCalls
      const killed0 = child['killed'] as number
      const err0 = M.logErrors.length
      h!()
      expect(M.quitCalls).toBe(quit0 + 1) // 首次：优雅退出链（单次语义不变）
      expect(exitSpy).not.toHaveBeenCalled()
      expect(child['killed']).toBe(killed0) // 优雅链不强杀 child
      h!() // 第二次同型：硬退出口
      expect(child['killed']).toBeGreaterThan(killed0) // killNow 先行（在途 child 同步 kill）
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(
        M.logErrors.slice(err0).some((l) => String((l as unknown[])[1]).includes('SIGINT')),
      ).toBe(true) // 硬退留痕
    } finally {
      exitSpy.mockRestore()
      onSpy.mockRestore()
    }
  })

  // 批 U3：崩溃风暴接线——manager 退避（默认 0/5s/15s，fake timers 快进）+ main 的
  // 封顶对话框（onRestartExhausted →「重启服务/退出应用」；R1010-P3 G7-② 改走异步
  // showMessageBox——同步版泵原生嵌套消息循环冻结主进程，断言面随之换 msgBox）
  it('崩溃风暴（批 U3）：3 次自动重启后封顶 → 异步对话框选「退出应用」→ quit 且不再 fork', async () => {
    vi.useFakeTimers()
    try {
      const forks0 = M.forkChildren.length
      const quit0 = M.quitCalls
      // R0911-G-P1-1b：msgBox 是文件级累积面（各用例间不重置）——切库用例在大小写
      // 敏感卷（ubuntu ext4）上经 warnIfCaseSensitive 真实探测 → showMessageBox 各留
      // 一条（mac/win 不敏感卷探测 false 零残留），绝对计数 toBe(1) 因此平台分叉
      //（CI ubuntu「expected 1 got 3」= 本用例前两次成功切库的警告残留 +2）。改快照
      // 增量口径（同 1338/1385 行 msgBoxSync/msgBox 先例）：断言只锚本用例净增 1 条，
      // 内容取快照下标，跨平台恒定。
      const box0 = M.msgBox.length
      M.msgResponse = 1 // 退出应用（showMessageBox 异步通道）
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await vi.advanceTimersByTimeAsync(0) // bootstrap + 首个 child ready 落定
      expect(M.forkChildren.length).toBe(forks0 + 1)
      // 4 轮崩溃：前 3 轮各触发一次自动重启（退避 0ms/5s/15s），第 4 轮转封顶
      for (let i = 0; i < 4; i++) {
        ;(M.forkChildren[M.forkChildren.length - 1] as unknown as { emit: (e: string, c: number) => void }).emit('exit', 1)
        await vi.advanceTimersByTimeAsync(16_000) // 覆盖当轮最长退避 15s（稳定窗口 5min 远未到）
      }
      expect(M.forkChildren.length).toBe(forks0 + 4) // 首启 + 3 次重启，封顶后无第 5 次
      expect(M.msgBox.length).toBe(box0 + 1) // 异步通道（非 showMessageBoxSync）——R0911-G-P1-1b 增量口径：敏感卷上前序切库警告不扰
      const stormBox = M.msgBox[box0] as { buttons?: string[]; message?: string } // R0911-G-P1-1b：取本用例那条（非 [0] 绝对下标）
      expect(stormBox.buttons).toEqual(['重启服务', '退出应用'])
      expect(stormBox.message).toContain('自动重启已停止')
      expect(M.quitCalls).toBeGreaterThan(quit0) // 选退出 → app.quit
    } finally {
      M.msgResponse = 2
      vi.useRealTimers()
    }
  })

  it('无单实例锁：立即 quit 且不注册生命周期（Z-P2-8）', async () => {
    const whenReady0 = M.whenReadyCalls
    const quit0 = M.quitCalls
    const windows0 = M.windows.length
    vi.resetModules()
    M.lock = false
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    expect(M.quitCalls).toBe(quit0 + 1)
    expect(M.whenReadyCalls).toBe(whenReady0) // 不进 whenReady
    expect(M.windows.length).toBe(windows0) // 不开窗
    M.lock = true
  })

  it('window-state 越界（屏幕外/过小）→ 丢弃恢复、默认尺寸兜底', async () => {
    writeFileSync(
      join(M.userData, 'window-state.json'),
      JSON.stringify({ bounds: { x: 5000, y: 5000, width: 300, height: 200 } }),
    )
    const windows0 = M.windows.length
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    const win = M.windows[windows0]!
    expect(win.opts.width).toBe(1200) // 1920×0.6=1152 不足产品下限，兜底 1200（保三栏）
    expect(win.opts.height).toBe(864) // 1080×0.8（旧口径 min(1237, 1080-80)=1000）
  })

  // 低-8（第十轮）：fresh module（此前用例的 before-quit 已把 shutdownStarted 永久置位，
  // 复用旧实例无法构造「退出窗口内 activate」的初始态，resetModules 重导）
  it('低-8（第十轮）：before-quit 2s 退出窗口内 activate 不再触发重 bootstrap', async () => {
    const windows0 = M.windows.length
    const forks0 = M.forkChildren.length
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    expect(M.windows.length).toBe(windows0 + 1) // fresh 模块 bootstrap 开一主窗

    // 关主窗（mainWindow = null；closed 回调同步跑并 app.quit）
    M.windows[M.windows.length - 1]!.emit('closed')

    // 进入 before-quit 优雅退出窗口（preventDefault + shutdownStarted 置位；
    // 清理 promise 异步收尾，紧接的 activate 正落在 2s 窗口内）
    const e = { preventDefault: vi.fn() }
    M.appOn['before-quit']!.at(-1)!(e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)

    // 退出途中 dock 点击 activate：不得再起 server/开新窗
    M.appOn['activate']!.at(-1)!()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(M.forkChildren.length).toBe(forks0 + 1) // 仅 fresh bootstrap 的那一次，无重入增量
    expect(M.windows.length).toBe(windows0 + 1) // 无退出途新窗口
  })

  it('welcome 态（批 U1/S-8）：无书库 → fork 不带 --dir，主窗加载 /welcome；token 跨模块加载稳定（U-6）', async () => {
    const fork0 = M.forkChildren.length
    const windows0 = M.windows.length
    // 移除 current（cwd 即 repo 根，无 .clwriting → findWorkDir 也落空）
    const backup = readFileSync(join(M.userData, 'workdir.json'), 'utf-8')
    rmSync(join(M.userData, 'workdir.json'))
    // 记住上一轮 token（studio-token.json 已在 userData）
    const tokenBefore = (JSON.parse(readFileSync(join(M.userData, 'studio-token.json'), 'utf-8')) as { token: string }).token
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const call = M.forkCalls.at(-1)!
    expect(call.args).not.toContain('--dir')
    // 独立 main 加载（模拟 main 重启）复用持久化 token（E-9b：经 env 注入）
    expect((call.options['env'] as Record<string, string | undefined>)['CLW_STUDIO_TOKEN']).toBe(tokenBefore)
    expect(M.windows.length).toBe(windows0 + 1)
    expect(M.windows.at(-1)!.loaded[0]).toBe('http://127.0.0.1:45678/welcome')
    // 还原 current，避免影响后续 readStore
    writeFileSync(join(M.userData, 'workdir.json'), backup)
    expect(M.forkChildren.length).toBe(fork0 + 1)
  })

  it('E-9c：反复选非书库目录 + 重新选择 → 循环 10 次封顶后退出（记 error 日志，不无限弹窗）', async () => {
    // pickLibrary 由 open-library IPC/菜单触发（bootstrap welcome 态不经选择器）
    // 每轮都选非书库目录，且二次确认恒选「重新选择」（response=1）
    const notLib = mkTmp('e9c-notlib-')
    M.dialogOpen = { canceled: false, filePaths: [notLib] }
    M.msgResponse = 1
    const calls0 = M.dialogOpenCalls
    const err0 = M.logErrors.length
    const r = await M.ipcHandle['desktop:open-library']!(trustedEvent())
    // 恰好 10 次（封顶退出，不无限弹窗）；封顶按取消收口 → { canceled: true }
    expect(M.dialogOpenCalls - calls0).toBe(10)
    expect(r).toEqual({ ok: false, canceled: true })
    expect(M.logErrors.length).toBeGreaterThan(err0) // 封顶退出已记 error 留痕
    // 还原现场，避免影响后续用例
    M.dialogOpen = { canceled: true, filePaths: [] }
    M.msgResponse = 2
  })

  it('时序 2（批 U1）：boot-error（EADDRINUSE）→ 原生错误对话框 + 退出，不开窗不 fork 增量外动作', async () => {
    M.forkBehavior = 'boot-error'
    // nano-12（四轮处置批）：裸还原改 finally——断言中途抛错时共享桩滞留 'boot-error'
    // 会连锁毒化后续所有重导入用例（fresh module 全走 EADDRINUSE 形态假红）。
    try {
      const windows0 = M.windows.length
      const quit0 = M.quitCalls
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      expect(M.errorBox.length).toBe(1)
      expect(M.errorBox[0]![0]).toContain('启动失败')
      expect(M.errorBox[0]![1]).toContain('EADDRINUSE')
      expect(M.windows.length).toBe(windows0) // 启动失败不开窗
      expect(M.quitCalls).toBeGreaterThan(quit0) // onError → app.quit
    } finally {
      M.forkBehavior = 'ready'
    }
  })

  // X-26（第五十六轮）：裸 reload 无退避——崩溃风暴下无限 reload 打转（每次 reload 起
  // 一新渲染进程旋即又崩）；对齐 server child 退避协议轻量版：连续 3 次自愈后再崩 →
  // 停 reload 改载 data: 提示页。fresh module 保崩溃计数从零起（不受首 describe 用例
  // 对首窗崩溃次数的残留影响；置于文件尾——resetModules 会重绑 ipcHandle，其后无
  // 依赖原模块 handler 的用例）。
  it('X-26：连续 3 次自愈后仍崩 → 停止 reload，改载 data: 提示页（退避封顶）', async () => {
    const windows0 = M.windows.length
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const win = M.windows[windows0]!
    expect(win, 'fresh 模块应已开主窗').toBeTruthy()
    const h = win.webContents.handlers['render-process-gone']![0]! as (e: unknown, d: { reason: string; exitCode: number }) => void
    for (let i = 0; i < 3; i++) h({}, { reason: 'oom', exitCode: 5 })
    expect(win.webContents.reloaded).toBe(3) // 封顶前逐次自愈 reload
    const loaded0 = win.loaded.length
    h({}, { reason: 'oom', exitCode: 5 }) // 第 4 次崩溃：封顶
    expect(win.webContents.reloaded).toBe(3) // 不再 reload（无限循环止步）
    expect(win.loaded.length).toBe(loaded0 + 1) // 改载静态提示页
    expect(String(win.loaded[win.loaded.length - 1])).toMatch(/^data:text\/html/)
  })

  // S6（五十九轮）：rendererCrashes 只随窗口重建归零 → 长跑偶发 3 次崩溃后第 4 次
  // 误触发停摆页。修复对齐 server-manager STABILITY_RESET_MS 先例：did-finish-load
  // 后存活过稳定窗口（5 分钟）即清零。fake setTimeout 推进窗口（微任务不 fake，模块
  // 启动链不受影响）。
  it('S6: did-finish-load 后存活过稳定窗口 → 崩溃计数清零，后续崩溃回退避第 1 档', async () => {
    const windows0 = M.windows.length
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await import('../../src/desktop/main.js')
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      const win = M.windows[windows0]!
      expect(win, 'fresh 模块应已开主窗').toBeTruthy()
      const gone = win.webContents.handlers['render-process-gone']![0]! as (e: unknown, d: { reason: string; exitCode: number }) => void
      for (let i = 0; i < 3; i++) gone({}, { reason: 'oom', exitCode: 5 })
      expect(win.webContents.reloaded).toBe(3)
      // reload 成功 → did-finish-load；存活过 5 分钟稳定窗口 → 计数清零
      const finishLoad = win.webContents.handlers['did-finish-load']![0]! as () => void
      finishLoad()
      vi.advanceTimersByTime(5 * 60_000)
      const loaded0 = win.loaded.length
      gone({}, { reason: 'oom', exitCode: 5 }) // 原实现第 4 次误触发停摆页
      expect(win.webContents.reloaded).toBe(4) // 计数已清零 → 继续 reload 自愈
      expect(win.loaded.length).toBe(loaded0) // 未载 data: 停摆页
    } finally {
      vi.useRealTimers()
    }
  })

  // R43-26（四十三轮）：dev 环境变量防线——打包态（mock app.isPackaged=true）吃到宿主残留
  // CLW_DEV_UI=1 必须失效：devUi 真值判断要求非打包态（仍 fork server + loadURL 本地回传
  // 端口，不切 localhost:5173 HMR），CSP 注入条件同步收紧（打包态恒注入，不再被残留值跳过）。
  // fresh module 手法同上（resetModules 会重绑 ipcHandle，置于文件尾）。
  it('R43-26：打包态宿主残留 CLW_DEV_UI=1 → devUi 失效（仍 fork 本地 server）+ CSP 恒注入', async () => {
    const windows0 = M.windows.length
    const forks0 = M.forkChildren.length
    M.headersCb = null // 清掉首实例的注册，重导后 truthy 即「本轮新注册」
    vi.stubEnv('CLW_DEV_UI', '1')
    try {
      vi.resetModules()
      await import('../../src/desktop/main.js')
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      // devUi 门（!!env && !isPackaged）：打包残留不切 HMR——照常 fork + 加载 ready 回传端口
      expect(M.forkChildren.length).toBe(forks0 + 1)
      expect(M.windows.at(-1)!.loaded[0]).toBe('http://127.0.0.1:45678')
      // CSP 门（!(!!env && !isPackaged)）：打包态恒注入，残留 CLW_DEV_UI 不再放行跳过
      expect(M.headersCb, '打包态 CSP 应恒注入').toBeTruthy()
      let cbArg: unknown
      M.headersCb!({ responseHeaders: { 'content-type': ['text/html'] } }, (r) => (cbArg = r))
      const csp = (cbArg as { responseHeaders: Record<string, string[]> }).responseHeaders[
        'Content-Security-Policy'
      ]![0]!
      expect(csp).toContain("default-src 'self'")
      expect(M.windows.length).toBe(windows0 + 1)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
