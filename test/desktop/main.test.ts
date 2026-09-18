/**
 * kk-P2-8：Electron 主进程 main.ts 自动化（此前 718 行 0% 覆盖、仅靠人工冒烟）。
 *
 * 手法：vi.mock('electron') 全面假件 + 动态 import main.ts，驱动真实生命周期
 * （whenReady → CSP 注册 → registerIpc → buildMenu → bootstrap fork utility 假 child
 * + ready 握手开假窗口），对捕获面断言：
 * - 安全五件套窗口配置（contextIsolation/sandbox/nodeIntegration:false/preload）
 *   + 纵深防御（will-navigate 阻断 / 弹新窗拒绝）+ render-process-gone 自愈
 * - 生产 CSP 注入（default-src 'self' 基线锁定）
 * - utility fork 参数与握手（阶段 22 批 U1/U2：--dir/--user-data/--port 0/--token/
 *   serviceName 单列/stdio pipe + env 注入 CLW_LOG_STDOUT（单写者）+ loadURL 用
 *   ready 回传端口 = 时序等价锚点）；welcome 态（--dir 缺省）、token 跨模块加载
 *   稳定（U-6）、boot-error → 原生错误对话框 + 退出（时序 2）；before-quit 下发
 *   shutdown 指令（时序 4，非裸 kill）
 * - IPC 面：switch-library 校验与持久化、show-in-folder/open-book-dir 路径穿越守卫族、
 *   open-book 导航转发、context-menu 载荷校验与选择回传
 * - 原生菜单模板（生产无 devTools/reload；action click → menu-action 转发）
 * - second-instance --book 直进、window-state 越界丢弃、before-quit 优雅退出幂等、
 *   无单实例锁分支（quit 且不注册生命周期）
 * 灰盒边界：真实模块（workdir-store/install-books/initial-book/server-manager/
 * context-menu）真实跑（server-manager 的 fork 经 electron mock 的 utilityProcess
 * 假件注入）；electron/日志为假件。
 *
 * 拆分沿革（R0916-5b，2026-09-16）：原 2800 行单体按 describe 域拆出 5 个拆分件——
 * main-lifecycle-exit（退出与边界分支）/ main-close-flush（关窗/退出兜底 flush 族）/
 * main-window-resilience（窗口自愈/韧性）/ main-library-pick（书库选择/落库/readStore）/
 * main-reachability（失联卷预探/重启广播），用例整块原样搬移、用例总数与断言零变化；
 * 共享 mock 工厂与装置抽 main-fixtures.ts，④批 P2 监听器治理 harness（R0915-P2）
 * 抽 main-process-harness.ts 供各拆分件复用。本残核保留原文件前 3 个 describe 域
 * （启动链 / IPC 面 / 原生菜单与 second-instance）——该前缀对「首个 bootstrap 模块」
 * 的精确累计态有断言锚（如 forkCalls.length===1），保持原顺序原状态序列运行。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  M,
  mkTmp,
  mkLibrary,
  mainWin,
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

describe('kk-P2-8：主进程启动链（安全配置 / CSP / 内嵌 server）', () => {
  it.skipIf(process.platform !== 'win32')('win 渲染锐度：模块加载即注册 disable-gpu-rasterization（GPU 光栅层强制灰度 AA，压掉 F0 子像素——编辑区糊根因；mac 无 ClearType 不注册）', () => {
    expect(M.commandLineSwitches).toContainEqual(['disable-gpu-rasterization'])
  })

  it('安全五件套：contextIsolation+sandbox+nodeIntegration:false+preload（ii 批工厂基线）', () => {
    const wp = mainWin().opts.webPreferences
    expect(wp.contextIsolation).toBe(true)
    expect(wp.sandbox).toBe(true)
    expect(wp.nodeIntegration).toBe(false)
    expect(String(wp.preload)).toMatch(/preload\.cjs$/)
    // 资源项：纯中文应用关 Hunspell 词典（每渲染进程几 MB 常驻 + 按键路径开销）
    expect(wp.spellcheck).toBe(false)
  })

  it('win 无框标题栏+窗控 overlay（2026-08-29「外观向 mac 靠齐」+ 08-31「露出顶栏分隔线」）：titleBarStyle hidden + overlay 31px（比 --size-tabbar 32 矮 1px 让分隔线在窗控下完整露出）；mac 保持 hiddenInset', () => {
    const w = mainWin()
    expect(w.opts.autoHideMenuBar).toBe(process.platform === 'win32')
    if (process.platform === 'win32') {
      expect(w.opts.titleBarStyle).toBe('hidden')
      expect(w.opts.titleBarOverlay).toEqual({ color: '#f6f6f6', symbolColor: '#666666', height: 31 })
      expect(w.menuBarVisibility).toBe(false)
    } else if (process.platform === 'darwin') {
      expect(w.opts.titleBarStyle).toBe('hiddenInset')
    } else {
      // R40-32（四十轮）：linux 走默认系统标题栏（hiddenInset 非 Electron 支持值）
      expect(w.opts.titleBarStyle).toBeUndefined()
    }
  })

  // R40-32（四十轮）：titleBarStyle 平台分支——win 宿主经平台 mock 驱动新开窗口断言
  //（createSecureWindow 读当下 process.platform，主窗已按真实平台创建，改走
  // desktop:open-shelf 新开书架窗口；Object.defineProperty 手法对齐
  // test/document/r38-batch-f.test.ts:39-42）。
  it('R40-32: linux 新开窗不带 hiddenInset（默认标题栏）；darwin 保持 hiddenInset', async () => {
    const ORIG = process.platform
    const n0 = M.windows.length
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      M.ipcHandle['desktop:open-shelf']!(trustedEvent())
      await new Promise((r) => setImmediate(r))
      const linuxWin = M.windows[n0]!
      expect(linuxWin.opts.titleBarStyle).toBeUndefined() // 非支持值不外发
      expect(linuxWin.opts.titleBarOverlay).toBeUndefined()
      linuxWin.close() // 'closed' → shelfWindow 置空，单例让位下一轮

      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      M.ipcHandle['desktop:open-shelf']!(trustedEvent())
      await new Promise((r) => setImmediate(r))
      const macWin = M.windows[n0 + 1]!
      expect(macWin.opts.titleBarStyle).toBe('hiddenInset')
    } finally {
      Object.defineProperty(process, 'platform', { value: ORIG, configurable: true })
    }
  })

  it('纵深防御：will-navigate 阻断 + 弹新窗拒绝', () => {
    const wc = mainWin().webContents
    const nav = wc.handlers['will-navigate']![0]! as (e: { preventDefault: () => void }) => void
    const e = { preventDefault: vi.fn() }
    nav(e)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(wc.windowOpenHandler!()).toEqual({ action: 'deny' })
  })

  it('生产 CSP 注入：default-src self（responseHeaders 回调）', () => {
    expect(M.headersCb, 'whenReady 应注册 CSP 回调').toBeTruthy()
    let cbArg: unknown
    M.headersCb!({ responseHeaders: { 'content-type': ['text/html'] } }, (r) => (cbArg = r))
    const headers = (cbArg as { responseHeaders: Record<string, string[]> }).responseHeaders
    const csp = headers['Content-Security-Policy']![0]!
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("connect-src 'self'")
  })

  // 0918二轮修复批（C104）：CSP 补 frame-ancestors 'none'——frame-ancestors 不回落
  // default-src（CSP 规范独立指令），缺省即本地端口可被任意页面嵌 iframe（点击劫持
  // /DNS rebinding 纵深；API 侧 token 兜底之外补页面层防线）。
  it('C104（0918二轮修复批）：CSP 含 frame-ancestors \'none\'（防本地端口被嵌 iframe）', () => {
    expect(M.headersCb, 'whenReady 应注册 CSP 回调').toBeTruthy()
    let cbArg: unknown
    M.headersCb!({ responseHeaders: { 'content-type': ['text/html'] } }, (r) => (cbArg = r))
    const csp = (cbArg as { responseHeaders: Record<string, string[]> }).responseHeaders[
      'Content-Security-Policy'
    ]![0]!
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('utility fork 参数与主窗加载（批 U1）：--dir/--user-data/--port 0/token 经 env（E-9b）+ serviceName → loadURL', () => {
    expect(M.forkCalls.length).toBe(1)
    const call = M.forkCalls[0]!
    const dirVal = call.args[call.args.indexOf('--dir') + 1]
    expect(dirVal).toBe(libA)
    expect(call.args[call.args.indexOf('--user-data') + 1]).toBe(M.userData)
    expect(call.args[call.args.indexOf('--port') + 1]).toBe('0')
    // E-9b：token 不经 argv（ps 可见）——argv 面无 --token，只经 env CLW_STUDIO_TOKEN 注入
    expect(call.args).not.toContain('--token')
    expect((call.options['env'] as Record<string, string | undefined>)['CLW_STUDIO_TOKEN']).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
    )
    expect(call.args).not.toContain('--book')
    expect(call.args).not.toContain('--mirror-console') // mock isPackaged=true
    expect(call.options['serviceName']).toBe('studio-server')
    // 批 U2 单写者（§3.5）：stdio pipe 收行 + env 注入 CLW_LOG_STDOUT=1（展开拷贝继承）
    expect(call.options['stdio']).toBe('pipe')
    expect((call.options['env'] as Record<string, string | undefined>)['CLW_LOG_STDOUT']).toBe('1')
    expect(String(call.modulePath)).toMatch(/server-utility\.js$/)
    // 45678 只能来自 ready 消息回传——loadURL 用回传端口即「server ready 后才 loadURL」的时序锚点（验收门 2）
    expect(mainWin().loaded[0]).toBe('http://127.0.0.1:45678')
  })

  it('studioToken 持久化（U-6）：userData/studio-token.json 落盘且与 fork 传值一致', () => {
    const stored = JSON.parse(readFileSync(join(M.userData, 'studio-token.json'), 'utf-8')) as { token: string }
    const call = M.forkCalls[0]!
    // E-9b：token 注入面 = fork env CLW_STUDIO_TOKEN（argv 无 --token）
    expect(stored.token).toBe((call.options['env'] as Record<string, string | undefined>)['CLW_STUDIO_TOKEN'])
  })

  it('window-state 恢复：合法 bounds → 主窗尺寸取存量值', () => {
    expect(mainWin().opts.width).toBe(1500)
    expect(mainWin().opts.height).toBe(900)
  })

  it('render-process-gone 自愈：记日志 + 重载窗口（dd-P3）', () => {
    const win = mainWin()
    const h = win.webContents.handlers['render-process-gone']![0]! as (e: unknown, d: { reason: string; exitCode: number }) => void
    h({}, { reason: 'oom', exitCode: 5 })
    expect(M.logErrors.length).toBeGreaterThan(0)
    expect(win.webContents.reloaded).toBe(1)
  })
})

describe('kk-P2-8：IPC 面（校验 / 穿越守卫 / 导航转发）', () => {
  it('注册面：12 handle + context-menu on', () => {
    expect(Object.keys(M.ipcHandle).sort()).toEqual([
      'desktop:get-current',
      'desktop:get-recent',
      'desktop:get-system-fonts',
      'desktop:open-book',
      'desktop:open-book-dir',
      'desktop:open-library',
      'desktop:open-library-dir',
      'desktop:open-library-window',
      'desktop:open-shelf',
      'desktop:set-fullscreen',
      'desktop:set-titlebar-overlay',
      'desktop:show-in-folder',
      'desktop:switch-library',
    ].sort())
    expect(M.ipcOn['desktop:context-menu']).toBeTruthy()
  })

  it('set-fullscreen：按发起窗口 setFullScreen(flag===true)，非布尔收敛 false', () => {
    // R1010b-DSK-P3-5 适配：sender 白名单收窄为「工厂登记 webContents ∪ 工厂窗反查」，
    // 自建裸窗假件不再能走反查兜底——改在工厂窗实例上挂 setFullScreen 记录器承载
    //（isTrustedSender 走登记快路径；「按发起窗口」语义不变：目标窗 = sender 反查窗）
    const win = [...M.windows].reverse().find((w) => !w.isDestroyed())! // 同 trustedEvent 缺省锚
    const calls: boolean[] = []
    ;(win as unknown as { setFullScreen: (f: boolean) => void }).setFullScreen = (f) => calls.push(f)
    const ev = trustedEvent(win.webContents)
    M.ipcHandle['desktop:set-fullscreen']!(ev, true)
    M.ipcHandle['desktop:set-fullscreen']!(ev, false)
    M.ipcHandle['desktop:set-fullscreen']!(ev, 'yes')
    expect(calls).toEqual([true, false, false])
  })

  // R4-P2-1（2026-09-09 修复批）：sender 校验拒绝面——缺 senderFrame（帧销毁期）、
  // 异帧（senderFrame ≠ sender.mainFrame，被注入 iframe 的帧中帧形态）、白名单外
  // webContents（无窗口反查）全部拒绝；受信形态照常工作（回归锚）。
  it('R4-P2-1: IPC 非受信 sender 拒绝——null 事件/缺帧/异帧/裸 wc；受信形态仍工作', () => {
    const h = M.ipcHandle['desktop:get-current']!
    expect(h(null as never)).toBeUndefined() // 无事件对象（帧销毁期形态）
    expect(h({ sender: mainWin().webContents } as never)).toBeUndefined() // 缺 senderFrame
    expect(h({ sender: mainWin().webContents, senderFrame: { bogus: true } } as never)).toBeUndefined() // 异帧
    const foreign = { sent: [], on(): void {}, mainFrame: null as unknown } // 白名单外裸 wc（无窗口反查）
    foreign.mainFrame = foreign
    expect(h({ sender: foreign, senderFrame: foreign } as never)).toBeUndefined()
    expect(h(trustedEvent())).toBe(libA) // 受信形态回归锚（bootstrap 实际值）
  })

  // R74-21（七十四轮批 D）：overlay 颜色白名单——此前只验 typeof，任意长字符串直达
  // setTitleBarOverlay 靠 Electron 内部抛错兜底（catch 吞掉无痕）。校验置于平台守卫前
  //（与 isInvalidBookName「跨平台统一拒绝」口径一致），mac 上亦可测。
  it('R74-21: set-titlebar-overlay 颜色白名单——非法色回错误、合法 hex 放行（不再只验 typeof）', () => {
    // R1010b-DSK-P3-5 适配：sender 白名单收窄后自建裸窗不再能走反查兜底——改在工厂
    // 窗实例上挂 setTitleBarOverlay 记录器承载（isTrustedSender 走登记快路径，校验面
    // 断言不变；记录器窗与 sender 反查窗须同窗）
    const win = [...M.windows].reverse().find((w) => !w.isDestroyed())! // 同 trustedEvent 缺省锚
    const calls: Array<Record<string, unknown>> = []
    ;(win as unknown as { setTitleBarOverlay: (p: Record<string, unknown>) => void }).setTitleBarOverlay = (p) => {
      calls.push(p)
    }
    const ev = trustedEvent(win.webContents)
    const h = M.ipcHandle['desktop:set-titlebar-overlay']!
    // 非法：任意长字符串（修复前直达 Electron）、无 # 前缀、非 hex 字符、数字类型
    expect(h(ev, { color: 'x'.repeat(500) })).toMatchObject({ ok: false })
    expect(h(ev, { color: 'red' })).toMatchObject({ ok: false })
    expect(h(ev, { color: '#GGGGGG' })).toMatchObject({ ok: false })
    expect(h(ev, { symbolColor: '#12' })).toMatchObject({ ok: false })
    expect(h(ev, { color: 12345 })).toMatchObject({ ok: false })
    // R38-20（三十八轮）：5/7 位非法 hex 拒绝——原 {3,8} 放行后 Electron 内部校验
    // 抛错被 catch 吞、深浅色切换静默失效；收紧为 CSS 合法位数集合 3/4/6/8
    expect(h(ev, { color: '#12345' })).toMatchObject({ ok: false })
    expect(h(ev, { symbolColor: '#1234567' })).toMatchObject({ ok: false })
    // 合法 hex（3/6/8 位）放行：返回非错误；win32 下转发 setTitleBarOverlay（mac 上
    // 平台守卫 no-op，仅验校验面）
    expect(h(ev, { color: '#f6f6f6', symbolColor: '#666' })).toBeUndefined()
    expect(h(ev, { color: '#262626FF' })).toBeUndefined()
    if (process.platform === 'win32') {
      expect(calls).toEqual([{ color: '#f6f6f6', symbolColor: '#666' }, { color: '#262626FF' }])
    } else {
      expect(calls).toEqual([]) // 非 win 平台守卫 no-op，不应触达 setTitleBarOverlay
    }
    // 合法载荷后未销毁窗口上的既有空参形态维持 no-op（无字段 → undefined）
    expect(h(ev, {})).toBeUndefined()
  })

  it('专注全屏反向同步：enter/leave-full-screen → desktop:fullscreen-change 转发渲染层', () => {
    const win = mainWin()
    const n0 = win.webContents.sent.length
    for (const fn of win.handlers['enter-full-screen'] ?? []) fn()
    expect(win.webContents.sent[n0]?.[0]).toBe('desktop:fullscreen-change')
    expect(win.webContents.sent[n0]?.[1]).toBe(true)
    for (const fn of win.handlers['leave-full-screen'] ?? []) fn()
    expect(win.webContents.sent[n0 + 1]?.[0]).toBe('desktop:fullscreen-change')
    expect(win.webContents.sent[n0 + 1]?.[1]).toBe(false)
  })

  it('switch-library：不存在路径/他库子目录拒绝；合法目录持久化 current 并触发 relaunch', async () => {
    // R41-1（四十一轮）契约演进：守卫由 isLibraryDir（要求自身含 .clwriting/）改
    // canSwitchLibraryDir（bootstrap 接受面 = 目录存在即可）——原「非书库目录拒绝」
    // 用例的空目录输入从拒绝转为放行（待建空书库正是本修复要救活的形态），拒绝面
    // 改由「不存在路径」与「另一书库的子目录」承载
    const bad = await M.ipcHandle['desktop:switch-library']!(trustedEvent(), mkTmp('not-a-lib-') + '/不存在')
    expect(bad).toEqual({ ok: false, reason: '目录无效或是另一书库的子目录' })
    const sub = await M.ipcHandle['desktop:switch-library']!(trustedEvent(), join(libA, 'books'))
    expect(sub).toEqual({ ok: false, reason: '目录无效或是另一书库的子目录' })
    const good = mkLibrary()
    const before = M.relaunchCalls
    const quitBefore = M.quitCalls
    const r = await M.ipcHandle['desktop:switch-library']!(trustedEvent(), good)
    expect(r).toEqual({ ok: true })
    const stored = JSON.parse(readFileSync(join(M.userData, 'workdir.json'), 'utf8')) as { current: string }
    expect(stored.current).toBe(good)
    // R51-A-1（五十一轮）：setTimeout(relaunch, 100) 只记切库意图并触发优雅退出
    //（quitCalls+1），不再当场武装重启——relaunch/release 推迟到 before-quit 不可
    // 回头点（A-1 专项用例验证武装与取消丢弃语义）
    await vi.waitFor(() => expect(M.quitCalls).toBeGreaterThan(quitBefore))
    expect(M.relaunchCalls).toBe(before)
    expect(M.releaseLockCalls).toBe(0)
    // 还原 current，避免影响后续用例的 readStore
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: libA, recent: [] }))
  })

  it('R41-1: switch-library 接受待建空书库——pickLibrary「在此新建」落库的空目录不再成死条目', async () => {
    // 修复前：空目录无 .clwriting → isLibraryDir 拒 → 最近列表点回恒败（永久死条目）；
    // 修复后：目录存在 + 无祖先书库 → 放行（bootstrap 同语义）
    const empty = mkTmp('clw-empty-lib-')
    const before = M.relaunchCalls
    const quitBefore = M.quitCalls
    const r = await M.ipcHandle['desktop:switch-library']!(trustedEvent(), empty)
    expect(r).toEqual({ ok: true })
    const stored = JSON.parse(readFileSync(join(M.userData, 'workdir.json'), 'utf8')) as { current: string }
    expect(stored.current).toBe(empty)
    // R51-A-1：意图 + quit（不当场武装，同上）
    await vi.waitFor(() => expect(M.quitCalls).toBeGreaterThan(quitBefore))
    expect(M.relaunchCalls).toBe(before)
    expect(M.releaseLockCalls).toBe(0)
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: libA, recent: [] }))
  })

  it('get-current / get-recent：读持久化 store', () => {
    expect(M.ipcHandle['desktop:get-current']!(trustedEvent())).toBe(libA)
    expect(Array.isArray(M.ipcHandle['desktop:get-recent']!(trustedEvent()))).toBe(true)
  })

  it('Y-11（第五十七轮）：get-current 走 currentWorkDir——bootstrap 实际值优先于 store 回读', () => {
    // harness 的 bootstrap 已完成（bootstrappedWorkDir = libA）；改写 store.current 为
    // 另一目录后，get-current 应仍返回 bootstrap 实际值（修复前裸读 store 会返回 libB，
    // 与实际运行书库不一致——书库管理窗口展示口径失真）
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: '/tmp/别处书库', recent: [] }))
    try {
      expect(M.ipcHandle['desktop:get-current']!(trustedEvent())).toBe(libA)
    } finally {
      writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: libA, recent: [] }))
    }
  })

  // 重审-2：handler 改 async（失联卷预探）——本组调用统一 await 后断言
  it('show-in-folder 穿越守卫：.. 逃逸 / NUL / 未登记书 全拒；合法路径 realpath 放行', async () => {
    const h = M.ipcHandle['desktop:show-in-folder']!
    const n0 = M.shell.show.length
    await h(trustedEvent(), '书A', '../escape.md')
    await h(trustedEvent(), '书A', '第1章-开篇.md\0evil')
    await h(trustedEvent(), '未登记', '第1章-开篇.md')
    await h(trustedEvent(), null, 'x')
    expect(M.shell.show.length).toBe(n0)
    await h(trustedEvent(), '书A', '第1章-开篇.md')
    expect(M.shell.show.length).toBe(n0 + 1)
    expect(M.shell.show[n0]).toContain('第1章-开篇.md')
  })

  it('show-in-folder 篡改守卫：books.jsonl entry.path 越出 workDir → 拒绝', async () => {
    const lib = mkLibrary()
    writeFileSync(join(lib, '.clwriting', 'books.jsonl'), `${JSON.stringify({ name: '坏书', path: '../outside' })}\n`)
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: lib, recent: [] }))
    const n0 = M.shell.show.length
    await M.ipcHandle['desktop:show-in-folder']!(trustedEvent(), '坏书', 'any.md')
    expect(M.shell.show.length).toBe(n0)
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: libA, recent: [] }))
  })

  it('open-book-dir 同口径：合法 realpath 放行、越出 workDir 拒绝', async () => {
    const n0 = M.shell.open.length
    await M.ipcHandle['desktop:open-book-dir']!(trustedEvent(), '书A')
    expect(M.shell.open.length).toBe(n0 + 1)
    expect(M.shell.open[n0]).toContain(join('books', 'a'))
    const lib = mkLibrary()
    writeFileSync(join(lib, '.clwriting', 'books.jsonl'), `${JSON.stringify({ name: '坏书', path: '../outside' })}\n`)
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: lib, recent: [] }))
    await M.ipcHandle['desktop:open-book-dir']!(trustedEvent(), '坏书')
    expect(M.shell.open.length).toBe(n0 + 1)
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: libA, recent: [] }))
  })

  it('open-book：主窗 desktop:navigate 编码转发 + 聚焦', () => {
    const win = mainWin()
    const n0 = win.webContents.sent.length
    M.ipcHandle['desktop:open-book']!(trustedEvent(), '书A')
    const sent = win.webContents.sent[n0]!
    expect(sent[0]).toBe('desktop:navigate')
    expect(sent[1]).toBe(`/book/${encodeURIComponent('书A')}`)
    expect(win.focused).toBeGreaterThan(0)
  })

  it('context-menu：合法载荷建菜单、点选回传 key；非法载荷整体忽略', () => {
    const win = mainWin()
    const sender = win.webContents
    const built0 = M.menuBuilt
    M.ipcOn['desktop:context-menu']!({ sender, senderFrame: sender.mainFrame }, '不是数组')
    expect(M.menuBuilt).toBe(built0)
    M.ipcOn['desktop:context-menu']!({ sender, senderFrame: sender.mainFrame }, [{ label: '复制', key: 'copy', accelerator: 'CmdOrCtrl+C' }])
    expect(M.menuBuilt).toBe(built0 + 1)
    const item = (M.menuTemplate![M.menuTemplate!.length - 1] as { click?: () => void })
    const n0 = win.webContents.sent.length
    item.click!()
    const sent = win.webContents.sent[n0]!
    expect(sent[0]).toBe('desktop:context-menu-select')
    expect(sent[1]).toBe('copy')
  })

  it('N-4（第十二轮）：菜单滞留期间窗口销毁 → click/关闭回调晚到不再向已毁 webContents send', async () => {
    // R1010b-DSK-P3-5 适配：sender 白名单收窄后自建裸窗不再能走反查兜底——改用工厂
    // 书库窗承载（登记快路径）；「窗销毁随 wc 销毁」由 webContents 实例的 isDestroyed
    // 覆写承载（FakeWebContents 层无销毁联动，原假件由 win.close 同步置位，sendOnce
    // 判 sender 本体的语义等价）
    M.ipcHandle['desktop:open-library-window']!(trustedEvent())
    await new Promise((r) => setImmediate(r))
    const win = [...M.windows].reverse().find((w) => w.opts.title === '书库')!
    const wc = win.webContents as unknown as Record<string, any>
    let destroyed = false
    wc.isDestroyed = (): boolean => destroyed
    M.ipcOn['desktop:context-menu']!({ sender: wc, senderFrame: wc.mainFrame }, [{ label: '删除', key: 'delete' }])
    const item = (M.menuTemplate![M.menuTemplate!.length - 1] as { click?: () => void })
    destroyed = true // 菜单仍开着，窗口先关（isDestroyed → true）——点选晚到
    const n0 = wc.sent.length
    // 修复前：对已销毁 webContents send 抛「Object has been destroyed」进主进程
    expect(() => item.click!()).not.toThrow()
    // popup 关闭回调（延后一拍补发 null）同守卫覆盖
    M.popupCb?.()
    await new Promise((r) => setTimeout(r, 5))
    expect(wc.sent.length).toBe(n0) // 两路都无回传
    // 清理：还原 isDestroyed 覆写 + 关书库窗（单例/登记面让位后续用例）
    delete wc.isDestroyed
    win.close()
  })

  // R1010b-DSK-P3-6（2026-09-10 内存专项重审修复批）：取消补发 timer 排新清旧——原
  // popup callback 内裸排 setTimeout 不留句柄，菜单连续开关时旧补发叠跑（旧 timer 持
  // win/sender 引用滞留）。R0912（重评-0911c P3）：句柄由模块级单槽改 per-sender 分槽
  // ——单槽下 B 窗排新会清掉 A 窗在途补发（A 渲染层 once 收不到 null 挂等到下次开
  // 菜单）。本测试锁两条语义：同 sender 重排清旧（不叠发）+ 跨 sender 互不清。
  it('R1010b-DSK-P3-6 + R0912: context-menu 取消补发——同窗重排清旧不叠发，跨窗互不清', async () => {
    vi.useFakeTimers()
    try {
      // 第二个工厂窗承载第二份菜单载荷（渲染侧 ipcRenderer.once 只认第一条消息）
      M.ipcHandle['desktop:open-library-window']!(trustedEvent())
      await vi.advanceTimersByTimeAsync(0)
      const libWin = [...M.windows].reverse().find((w) => w.opts.title === '书库')!
      const wc1 = mainWin().webContents
      const wc2 = libWin.webContents
      const specs = [{ label: '复制', key: 'copy' }]
      const n1 = wc1.sent.length
      const n2 = wc2.sent.length
      // 同 sender 重排（R1010b 原语义）：wc1 连开两菜，菜单1 在途补发被菜单2 武装清除
      M.ipcOn['desktop:context-menu']!(trustedEvent(wc1), specs)
      M.popupCb?.() // 菜单1 关闭 → wc1 取消补发武装
      M.ipcOn['desktop:context-menu']!(trustedEvent(wc1), specs)
      M.popupCb?.() // 菜单2 关闭 → 排新清旧（清菜单1 在途补发，重武装 wc1）
      // 跨 sender 独立（R0912 修复点）：wc2 的武装不清 wc1 的在途补发
      M.ipcOn['desktop:context-menu']!(trustedEvent(wc2), specs)
      M.popupCb?.() // 菜单3（wc2）关闭 → 只武装 wc2
      await vi.advanceTimersByTimeAsync(200) // 取消补发窗（CONTEXT_MENU_CANCEL_DELAY_MS=100）已过
      expect(wc1.sent.slice(n1)).toEqual([
        ['desktop:context-menu-select', null], // 仅菜单2 一笔：菜单1 已被同窗重排清掉（不叠发）
      ]) // 且该笔在 wc2 排新后仍存续（修复前单槽被 wc2 清空 → 0 笔）
      expect(wc2.sent.slice(n2)).toEqual([['desktop:context-menu-select', null]]) // 菜单3 取消照常补发
      libWin.close() // 清理（书库窗单例让位）
    } finally {
      vi.useRealTimers()
    }
  })

  // 0918二轮修复批（C106）：contextMenuCancelTimers 强引用滞留——Map 持 WebContents，
  // 窗口正常销毁（closed）不摘除条目滞留至进程尾。修复 = 武装单点 armContextMenuCancelTimer
  // 首次写入时挂 webContents 'destroyed' 摘除（清 timer + 删条目）。
  it('C106（0918二轮修复批）：窗口销毁 → 取消补发条目随 destroyed 摘除、timer 已清', async () => {
    vi.useFakeTimers()
    try {
      vi.resetModules()
      await import('../../src/desktop/main.js')
      // 与 fresh main.js 同模块图的 ipc.js 实例（contextMenuCancelTimers 正本）——
      // __testHooks 先例同 windows.ts（生产零调用）
      const ipcMod = (await import('../../src/desktop/ipc.js')) as unknown as {
        __testHooks: { hasCancelTimer: (wc: unknown) => boolean; cancelTimerCount: () => number }
      }
      await vi.advanceTimersByTimeAsync(0) // bootstrap + 首窗创建落定
      await M.ipcHandle['desktop:open-library-window']!(trustedEvent())
      await vi.advanceTimersByTimeAsync(0) // 子窗 openSingletonWindow 微任务链（loadURL 前）
      const libWin = [...M.windows].reverse().find((w) => w.opts.title === '书库')!
      const wc = libWin.webContents as unknown as Record<string, any>
      M.ipcOn['desktop:context-menu']!(trustedEvent(wc), [{ label: '删除', key: 'delete' }])
      M.popupCb?.() // 菜单关闭 → 取消补发武装（100ms timer 入 per-sender 槽）
      expect(ipcMod.__testHooks.hasCancelTimer(wc)).toBe(true) // 武装在册
      const sent0 = wc.sent.length
      // 窗口销毁：webContents 'destroyed' emit（真实 Electron 随窗销毁派发）
      for (const fn of wc.handlers['destroyed'] ?? []) fn()
      expect(ipcMod.__testHooks.hasCancelTimer(wc)).toBe(false) // 条目已摘除（修复前滞留至进程尾）
      await vi.advanceTimersByTimeAsync(200) // 越过原 100ms 补发窗——timer 已清，无迟到补发
      expect(wc.sent.length).toBe(sent0)
      libWin.close() // 清理（书库窗单例让位；closed 链对已摘除条目幂等）
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('kk-P2-8：原生菜单与 second-instance', () => {
  it('生产菜单：无 reload/devTools；业务 action click → menu-action 转发', () => {
    const startup = M.menuHistory![0]!
    const labels = startup.map((m) => (m as { label?: string }).label)
    for (const want of ['文件', '编辑', '视图', '窗口']) expect(labels).toContain(want)
    const roles = JSON.stringify(startup)
    expect(roles).not.toContain('toggleDevTools')
    expect(roles).not.toContain('forceReload')
    // 找「新建书…」的 action click，聚焦窗口转发
    M.focusedWin = mainWin()
    const file = startup.find((m) => (m as { label?: string }).label === '文件') as { submenu: Array<Record<string, any>> }
    const newBook = file.submenu.find((i) => i.label === '新建书…')!
    const n0 = mainWin().webContents.sent.length
    newBook.click()
    const sent = mainWin().webContents.sent[n0]!
    expect(sent[0]).toBe('desktop:menu-action')
    expect(sent[1]).toBe('new-book')
  })

  // 复审-0913-mac适配 P3-7：⌘F 此前无全局查找入口——编辑子菜单补「查找…」项，
  // 经 action('find') 既有通路转发主窗（前端 useAppActions 'find' → EditorView.openSearch）
  it('编辑菜单含「查找…」⌘F：位置在 selectAll 后，click 转发 find 到主窗', () => {
    const startup = M.menuHistory![0]!
    const edit = startup.find((m) => (m as { label?: string }).label === '编辑') as {
      submenu: Array<Record<string, any>>
    }
    const findIdx = edit.submenu.findIndex((i) => i.label === '查找…')
    expect(findIdx).toBeGreaterThan(-1)
    const find = edit.submenu[findIdx]!
    expect(find.accelerator).toBe('CmdOrCtrl+F')
    const selIdx = edit.submenu.findIndex((i) => i.role === 'selectAll')
    expect(selIdx).toBeGreaterThan(-1)
    expect(findIdx).toBeGreaterThan(selIdx) // 紧随全选，排在编辑子菜单尾
    const win = mainWin()
    const n0 = win.webContents.sent.length
    find.click()
    const sent = win.webContents.sent[n0]!
    expect(sent[0]).toBe('desktop:menu-action')
    expect(sent[1]).toBe('find')
  })

  // 重评-P3-11（2026-09-09 全量代码重评）：直进链补 probeDirReachable 预探——活卷上
  // stat 走 statSync 同步垫底（微任务级），导航不再同步发生，断言前冲刷一拍
  it('second-instance --book 直进：解析登记书 → 主窗导航 + 聚焦', async () => {
    const h = M.appOn['second-instance']![0]!
    const win = mainWin()
    const n0 = win.webContents.sent.length
    h({}, ['electron', '--book', '书A'])
    await new Promise((r) => setImmediate(r)) // 预探微任务冲刷（statSync 垫底口径）
    const sent = win.webContents.sent[n0]!
    expect(sent[0]).toBe('desktop:navigate')
    expect(sent[1]).toBe(`/book/${encodeURIComponent('书A')}`)
    expect(win.focused).toBeGreaterThan(0) // 聚焦不受预探影响（handler 尾部同步执行）
  })

  // P3（打包修复批）：启动早期/书未登记时的 --book 忽略路径原为静默——必须留痕
  it('second-instance --book 未匹配登记书：无导航 + info 留痕含书名（不再静默吞）', async () => {
    const h = M.appOn['second-instance']![0]!
    const win = mainWin()
    const n0 = win.webContents.sent.length
    const infos0 = M.logInfos.length
    h({}, ['electron', '--book', '不存在的书'])
    await new Promise((r) => setImmediate(r)) // 预探微任务冲刷
    expect(win.webContents.sent.length).toBe(n0) // 无导航（行为不变）
    const line = M.logInfos[infos0] as unknown[]
    expect(line![1]).toContain('不存在的书') // 留痕含被忽略的 --book 值
    expect(String(line![1])).toContain('已忽略')
  })

  it('second-instance --book 但主窗不可用：warn 留痕含书名，无导航无聚焦', () => {
    const h = M.appOn['second-instance']![0]!
    const win = mainWin()
    const n0 = win.webContents.sent.length
    const f0 = win.focused
    const warns0 = M.logWarns.length
    win.close() // isDestroyed → 直达分支不可用（模拟启动早期窗口未建/已毁）
    try {
      h({}, ['electron', '--book', '书A'])
      expect(win.webContents.sent.length).toBe(n0)
      expect(win.focused).toBe(f0) // 窗口不可用：聚焦分支同样跳过
      const line = M.logWarns[warns0] as unknown[]
      expect(line![0]).toBe('main')
      expect(String(line![1])).toContain('书A') // warn 含被忽略的 --book 值
      expect(String(line![1])).toContain('已忽略')
    } finally {
      // 恢复窗口存活态（fake close 只置 closed 标记，可逆），避免影响后续用例
      win.closed = false
    }
  })

  // R0912-3（重评-0912 P3 #36）：mac 双开拉起可能只聚焦不置前——second-instance 尾部
  // 补 darwin app.focus({steal:true})（steal = 自其他 app 强制夺焦并置前）；win/linux
  // 不调（默认 focus 语义已足），win.focus() 各平台照常。
  // 前置用例（主窗不可用形态）会把首实例的 mainWindow 置 null——fresh module 取干净
  // 实例（同重评-P3-11 手法），handler 取 at(-1)。
  it('R0912-3 #36: second-instance 尾部 darwin app.focus({steal:true})，主窗 focus 照常', async () => {
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const h = M.appOn['second-instance']!.at(-1)!
    const win = M.windows.at(-1)!
    const f0 = win.focused
    const focus0 = M.appFocus.length // M 共享态：既有 second-instance 用例已写过聚焦捕获面
    h({}, []) // 无 --book 的普通双开拉起（直达聚焦尾部）
    if (process.platform === 'darwin') {
      expect(M.appFocus.slice(focus0)).toEqual([{ steal: true }]) // steal 语义参数钉定
    } else {
      expect(M.appFocus.length).toBe(focus0) // 非 darwin 平台不调 app.focus
    }
    expect(win.focused).toBe(f0 + 1) // 主窗聚焦不受影响（应用内置前）
  })

  // 0918二轮修复批（C105）：菜单 action 回退 `?? getAllWindows()[0]` 删除——主窗销毁
  // 窗口期（close 拦截 flush/退出链在途，菜单仍可点）首窗可能是无 useAppActions 接线
  // 的子窗，动作发进子窗即静默丢失；修复后回退限主窗存在才发送，主窗不存在 log.warn
  // 留痕（动作丢弃可见），不向任何窗口外发。
  it('C105（0918二轮修复批）：主窗销毁窗口期菜单 action 不回退首窗——丢弃留痕不外发', async () => {
    const windows0 = M.windows.length
    vi.resetModules()
    await import('../../src/desktop/main.js')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    // 书架子窗在位 = 修复前 getAllWindows()[0] 的「首窗候选」（无 useAppActions 接线）
    await M.ipcHandle['desktop:open-shelf']!(trustedEvent())
    await new Promise((r) => setImmediate(r))
    const shelf = [...M.windows].reverse().find((w) => w.opts.title === '书架')!
    const sentCounts = M.windows.map((w) => w.webContents.sent.length)
    const main = M.windows[windows0]! // 本轮 fresh 主窗（不碰首实例 windows[0]）
    main.close() // FakeWin.close → 'closed' → wins.mainWindow=null（菜单模板仍可点）
    const warns0 = M.logWarns.length
    const template = M.menuHistory!.at(-1)!
    const file = template.find((m) => (m as { label?: string }).label === '文件') as {
      submenu: Array<Record<string, any>>
    }
    const newBook = file.submenu.find((i) => i.label === '新建书…')!
    expect(() => newBook.click!()).not.toThrow() // 修复前：回退首窗发送（动作丢失且无痕）
    expect(M.logWarns.length).toBeGreaterThan(warns0) // 丢弃留痕可见
    expect(String((M.logWarns.at(-1) as unknown[])[1])).toContain('new-book') // 留痕含动作 key
    M.windows.forEach((w, i) => {
      expect(w.webContents.sent.length, `窗口 ${i} 不得收到 menu-action`).toBe(sentCounts[i]!)
    })
    shelf.close() // 清理：书架子窗让位后续用例
  })
})
