/**
 * R0916-5b（2026-09-16，main.test.ts 拆分批）：kk-P2-8 主进程自动化测试共享 mock 工厂
 * 与装置——原 test/desktop/main.test.ts 头部（mock 状态捕获面 / vi.mock 五件 / mkTmp/
 * mkLibrary 夹具 / 文件级 beforeAll·afterAll 装置 / mainWin·trustedEvent 助手）原样
 * 抽取，供各 main-*.test.ts 拆分件复用。
 *
 * vi.mock 提升规则：本模块经任一拆分件顶层 import 即完成注册（拆分件的动态
 * import('../../src/desktop/main.js') 全部发生在 beforeAll/用例内，晚于本模块求值，
 * 时序安全）；工厂内不引用被 mock 模块真件的顶层导入，M 经 vi.hoisted 先于工厂可见
 * ——与原单体文件同构。
 * 池语义：vitest forks 池 isolate 默认开——每个测试文件独立 fork 进程 + 全新模块图，
 * 本模块的 M 捕获面/env 前值/临时目录记账按文件隔离，拆分件之间零串扰。
 */
import { expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** mock 状态与捕获面（vi.hoisted 保证 vi.mock 工厂可见） */
const M_hoisted = vi.hoisted(() => ({
  lock: true,
  userData: '',
  quitCalls: 0,
  relaunchCalls: 0,
  releaseLockCalls: 0, // R51-A-1：锁释放推迟到不可回头点——释放调用捕获面
  exitCodes: [] as number[], // R0910-W：窗口循环冒烟 app.exit(code) 捕获面
  whenReadyCalls: 0,
  setPaths: {} as Record<string, string>,
  appOn: {} as Record<string, Array<(...a: unknown[]) => void>>,
  commandLineSwitches: [] as Array<string[]>, // win 渲染锐度（F 线）：main.ts 模块加载期注册的命令行开关
  headersCb: null as null | ((d: unknown, cb: (r: unknown) => void) => void),
  ipcHandle: {} as Record<string, (e: unknown, ...a: unknown[]) => unknown>,
  ipcOn: {} as Record<string, (e: unknown, ...a: unknown[]) => void>,
  menuTemplate: null as null | Array<Record<string, unknown>>,
  menuHistory: null as null | Array<Array<Record<string, unknown>>>,
  menuBuilt: 0,
  popupCb: null as null | (() => void),
  dialogOpen: { canceled: true, filePaths: [] as string[] },
  dialogOpenCalls: 0, // E-9c：pickLibrary 循环封顶断言用
  /** 起点记忆批：showOpenDialog 实收选项捕获面（判 defaultPath 有/无） */
  dialogOpenOpts: [] as Array<Record<string, unknown>>,
  msgResponse: 2,
  shell: { show: [] as string[], open: [] as string[] },
  windows: [] as Array<Record<string, any>>,
  focusedWin: null as null | Record<string, any>,
  logErrors: [] as unknown[],
  logWarns: [] as unknown[], // P3（打包修复批）：second-instance --book 忽略留痕断言用
  logInfos: [] as unknown[],
  appFocus: [] as unknown[], // R0912-3 #36：second-instance darwin app.focus({steal:true}) 捕获面
  // ── 阶段 22 批 U1：utilityProcess 假件捕获面 ──
  forkCalls: [] as Array<{ modulePath: string; args: string[]; options: Record<string, unknown> }>,
  forkChildren: [] as Array<Record<string, any>>,
  /** 'ready'（默认，自动回传 ready 45678）/ 'boot-error'（回传 EADDRINUSE 信封后退出）/
   *  'pending'（不回任何消息——握手挂起形态，R0912-3 #35 backstop 竞速用例） */
  forkBehavior: 'ready' as 'ready' | 'boot-error' | 'pending',
  errorBox: [] as Array<[string, string]>,
  /** 阶段 53 S2：app.getVersion() 返回值（main 启动链经 env CLW_APP_VERSION 下发） */
  appVersion: '1.2.3-fake',
  // ── 阶段 22 批 U3：封顶对话框捕获面（0=重启服务 / 1=退出应用，缺省退出） ──
  msgBoxSync: [] as Array<Record<string, unknown>>,
  msgBoxSyncChoice: 1,
  // R1010-P3（G7-②）：异步对话框捕获面（崩溃风暴封顶 showMessageBox）
  msgBox: [] as Array<Record<string, unknown>>,
  // R44-15（四十四轮）：子窗尺寸钳制断言用——小工作区形态可注入（screen 桩读此值）
  workArea: { width: 1920, height: 1080 },
  // R0910-W（2026-09-10 修复批）：真实 Electron 窗口销毁后读 win.webContents 抛
  // "Object has been destroyed"——默认关闭不扰存量用例，回归用例按需打开。
  throwWebContentsOnDestroyed: false,
}))

vi.mock('electron', () => {
  class FakeWebContents {
    win: Record<string, any>
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    sent: Array<[string, ...unknown[]]> = []
    windowOpenHandler: ((...a: unknown[]) => { action: string }) | null = null
    reloaded = 0
    // R4-P2-1：顶层主帧 = 自身（isTrustedSender 的 senderFrame === sender.mainFrame
    // 判定形态；被注入 iframe 的帧才是不同的 frame 对象）
    mainFrame: FakeWebContents
    constructor(win: Record<string, any>) {
      this.win = win
      this.mainFrame = this
    }
    on(evt: string, fn: (...a: unknown[]) => void): void {
      ;(this.handlers[evt] ??= []).push(fn)
    }
    send(...a: [string, ...unknown[]]): void {
      this.sent.push(a)
    }
    isDestroyed(): boolean {
      return false // FakeWin.close 只置 win.closed；webContents 层由各用例自带假件覆盖
    }
    setWindowOpenHandler(fn: () => { action: string }): void {
      this.windowOpenHandler = fn
    }
    reload(): void {
      this.reloaded++
    }
    // R44-2（四十四轮）：close/before-quit 拦截的渲染层 flush 通道——记录调用 + 可配
    // 返回值（execJsResult：null=无钩子 / {conflict,failed} 信封）
    execJs: string[] = []
    execJsResult: unknown = null
    executeJavaScript(code: string): Promise<unknown> {
      this.execJs.push(code)
      return Promise.resolve(this.execJsResult)
    }
    // X-26：render-process-gone 封顶路径经 webContents.loadURL 载提示页——委托 win 层
    // 记录（win.loaded 断言 data: URL 用），与 BrowserWindow.loadURL 同构
    loadURL(u: string): Promise<void> {
      return this.win.loadURL(u)
    }
    session = { setProxy: async () => undefined }
  }
  class FakeWin {
    opts: Record<string, any>
    // R0910-W：真实 Electron 窗口销毁后读 webContents 抛 "Object has been destroyed"
    // （实测）——默认不抛（throwWebContentsOnDestroyed=false）不扰存量用例；回归用例
    // 打开后 Getter 在 closed 态抛错，精确复刻故障形态。内部一律经 _wc 访问。
    _wc: FakeWebContents
    get webContents(): FakeWebContents {
      if (M_hoisted.throwWebContentsOnDestroyed && this.closed) {
        throw new Error('Object has been destroyed')
      }
      return this._wc
    }
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    focused = 0
    closed = false
    loaded: string[] = []
    maximized = false
    // J5（win 菜单栏隐藏）：Electron 默认可见，记录 main.ts 的显式隐藏调用供断言
    menuBarVisibility = true
    setMenuBarVisibility(visible: boolean): void {
      this.menuBarVisibility = visible
    }
    constructor(opts: Record<string, any>) {
      this.opts = opts
      this._wc = new FakeWebContents(this)
      M_hoisted.windows.push(this as unknown as Record<string, any>)
    }
    loadURL(u: string): Promise<void> {
      this.loaded.push(u)
      return Promise.resolve()
    }
    on(evt: string, fn: (...a: unknown[]) => void): void {
      ;(this.handlers[evt] ??= []).push(fn)
    }
    focus(): void {
      this.focused++
    }
    close(): void {
      if (this.closed) return
      this.closed = true
      for (const fn of this.handlers['closed'] ?? []) fn()
    }
    // R44-2（四十四轮）：关窗兜底收口动作——destroy 直关（不触发 beforeunload）；
    // 与 close 分离（close 置 closed 但语义上是「可拦截关」，destroy 是「真关」）
    destroy(): void {
      this.closed = true
    }
    isDestroyed(): boolean {
      return this.closed
    }
    isMaximized(): boolean {
      return this.maximized
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return this.opts as { x: number; y: number; width: number; height: number }
    }
    getNormalBounds() {
      return this.getBounds()
    }
    maximize(): void {
      this.maximized = true
    }
    emit(evt: string, ...a: unknown[]): void {
      for (const fn of this.handlers[evt] ?? []) fn(...a)
    }
  }
  /** utilityProcess 假件（批 U1）：记录 fork 调用面 + 可控行为的握手回传。
   *  自带最小 pub-sub（mock 工厂不得引用外部绑定——vitest hoist TDZ）。 */
  class FakeUtilityProc {
    private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    posted: unknown[] = []
    killed = 0
    pid = 4242
    /** 批 U2：stdio pipe 契约面（main 侧转发在 manager 单测覆盖，此处 null 跳过） */
    stdout = null
    stderr = null
    constructor(modulePath: string, args: string[], options: Record<string, unknown>) {
      M_hoisted.forkCalls.push({ modulePath, args, options })
      M_hoisted.forkChildren.push(this as unknown as Record<string, any>)
      queueMicrotask(() => {
        if (M_hoisted.forkBehavior === 'boot-error') {
          this.emit('message', { type: 'boot-error', code: 'EADDRINUSE', message: '端口 0 已被占用（EADDRINUSE），请释放占用进程或用 --port 换端口' })
          this.emit('exit', 1)
        } else if (M_hoisted.forkBehavior === 'pending') {
          // 握手挂起形态：不回任何消息（stopChild 的 settle 竞速窗无法按时收口）
        } else {
          this.emit('message', { type: 'ready', port: 45678 })
        }
      })
    }
    on(evt: string, fn: (...a: unknown[]) => void): void {
      ;(this.handlers[evt] ??= []).push(fn)
    }
    once(evt: string, fn: (...a: unknown[]) => void): void {
      this.on(evt, fn)
    }
    emit(evt: string, ...a: unknown[]): void {
      for (const fn of [...(this.handlers[evt] ?? [])]) fn(...a)
    }
    postMessage(m: unknown): void {
      this.posted.push(m)
      // 批 U2：模拟真实 child 收 shutdown 指令 → shutdownStudio 落定 → 回执 + exit(0)
      if ((m as { type?: string })?.type === 'shutdown') {
        queueMicrotask(() => {
          this.emit('message', { type: 'shutdown-done' })
          this.emit('exit', 0)
        })
      }
    }
    kill(): boolean {
      this.killed++
      queueMicrotask(() => this.emit('exit', 0))
      return true
    }
  }
  return {
    app: {
      setPath: (k: string, v: string) => {
        M_hoisted.setPaths[k] = v
      },
      getPath: (k: string) => (k === 'userData' ? M_hoisted.userData : `/fake/${k}`),
      requestSingleInstanceLock: () => M_hoisted.lock,
      // R27-96（二十七轮）：relaunch 显式交接释放锁——桩补同款方法（真实 Electron app 有）
      // R51-A-1：捕获释放调用次数（武装时机推迟后仅在不可回头点发生）
      releaseSingleInstanceLock: () => {
        M_hoisted.releaseLockCalls++
        M_hoisted.lock = true // 锁释放后锁位回归可获取态
        return true
      },
      on: (evt: string, fn: (...a: unknown[]) => void) => {
        ;(M_hoisted.appOn[evt] ??= []).push(fn)
      },
      quit: () => {
        M_hoisted.quitCalls++
      },
      // R0910-W：窗口循环冒烟成功/失败经 app.exit(code) 收口——真 exit 会杀死 worker，
      // 捕获面记录 code 供断言（生产零调用该 API 的其他处）。
      exit: (code?: number) => {
        M_hoisted.exitCodes.push(code ?? 0)
      },
      // R0912-3 #36：app.focus(opts) 捕获面（second-instance darwin steal 断言用）
      focus: (opts?: unknown) => {
        M_hoisted.appFocus.push(opts ?? null)
      },
      relaunch: () => {
        M_hoisted.relaunchCalls++
      },
      whenReady: () => {
        M_hoisted.whenReadyCalls++
        return Promise.resolve()
      },
      commandLine: {
        appendSwitch: (...a: string[]) => {
          M_hoisted.commandLineSwitches.push(a)
        },
      },
      isPackaged: true,
      name: 'CLWriting',
      getAppPath: () => '/fake/app',
      // 阶段 53 S2：版本号——main 启动链读它下发子进程（env CLW_APP_VERSION），
      // 假件给固定版号供 fork env 注入面断言
      getVersion: () => M_hoisted.appVersion,
    },
    BrowserWindow: Object.assign(
      class extends FakeWin {},
      {
        // R0910-W：优先经 _wc 反查（走 webContents Getter 会在 closed+抛错模式下误炸）；
        // 直构的裸 win 假件（无 _wc）回落 webContents 属性，兼容两种形态。
        fromWebContents: (wc: unknown) =>
          M_hoisted.windows.find((w) => (w._wc ?? w.webContents) === wc) ?? null,
        getFocusedWindow: () => M_hoisted.focusedWin,
        // 0918二轮修复批（C105）：getAllWindows 假件（对齐真实 API 面，返回未销毁窗；
        // action() 首窗回退在 C105 修复前是唯一消费点——修复后生产零调用，仅供回归
        // 用例复刻「修复前回退首窗」的对照形态）。
        getAllWindows: () => M_hoisted.windows.filter((w) => !w.closed),
      },
    ),
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived: (fn: (d: unknown, cb: (r: unknown) => void) => void) => {
            M_hoisted.headersCb = fn
          },
        },
      },
    },
    screen: {
      getPrimaryDisplay: () => ({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        // R44-15（四十四轮）：workAreaSize 可注入（小工作区形态断言子窗钳制）
        workAreaSize: { ...M_hoisted.workArea },
      }),
      // R26-86：loadWinState 校验扩为 getAllDisplays 任一包含——mock 与主屏同款单屏面。
      // R1010-P3（G7-④）：校验口径整屏 bounds → workArea，假件补同形 workArea
      getAllDisplays: () => [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      ],
    },
    ipcMain: {
      handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
        M_hoisted.ipcHandle[ch] = fn
      },
      on: (ch: string, fn: (e: unknown, ...a: unknown[]) => void) => {
        M_hoisted.ipcOn[ch] = fn
      },
    },
    dialog: {
      showOpenDialog: async (a: Record<string, unknown>, maybeOpts?: Record<string, unknown>) => {
        M_hoisted.dialogOpenCalls++ // E-9c：计数（pickLibrary 封顶锚定）
        // 真 API 双参重载 (parentWindow, options)——单参形态 (options) 兼容（同 msgBox 假件）
        M_hoisted.dialogOpenOpts.push(maybeOpts ?? a)
        return M_hoisted.dialogOpen
      },
      // R1010-P3（G7-②）：异步对话框捕获面——崩溃风暴封顶改走此通道（0=重启服务 /
      // 1=退出应用，缺省沿用 msgResponse=2 → choice!==0 → quit）
      showMessageBox: async (a: Record<string, unknown>, maybeOpts?: Record<string, unknown>) => {
        M_hoisted.msgBox.push(maybeOpts ?? a)
        return { response: M_hoisted.msgResponse }
      },
      showMessageBoxSync: (a: Record<string, unknown>, maybeOpts?: Record<string, unknown>) => {
        // R44-2（四十四轮）：真 API 双参重载 (parentWindow, options)——单参形态 (options) 兼容
        M_hoisted.msgBoxSync.push(maybeOpts ?? a)
        return M_hoisted.msgBoxSyncChoice
      },
      showErrorBox: (title: string, msg: string) => {
        M_hoisted.errorBox.push([title, msg])
      },
    },
    Menu: {
      buildFromTemplate: (t: Array<Record<string, unknown>>) => {
        M_hoisted.menuTemplate = t
        ;(M_hoisted.menuHistory ??= []).push(t)
        M_hoisted.menuBuilt++
        return {
          popup: (o: { callback?: () => void }) => {
            M_hoisted.popupCb = o.callback ?? null
          },
        }
      },
      setApplicationMenu: () => undefined,
    },
    shell: {
      showItemInFolder: (p: string) => {
        M_hoisted.shell.show.push(p)
      },
      openPath: async (p: string) => {
        M_hoisted.shell.open.push(p)
        return ''
      },
    },
    // 阶段 22 批 U1：utilityProcess 假件——server-manager 经此注入 fork；假 child
    // 下一拍按 forkBehavior 回传握手消息（ready 45678 / boot-error EADDRINUSE 后退出）
    utilityProcess: {
      fork: (modulePath: string, args: string[], options: Record<string, unknown>) =>
        new FakeUtilityProc(modulePath, args, options),
    },
  }
})

vi.mock('../../src/fs/user-data-path.js', () => ({
  defaultUserDataPath: () => M_hoisted.userData,
  // R1W-7：isLibraryDir/--book 路径匹配收编的同一性原语（win 小写降口径；mock 同语义）
  samePath: (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b,
}))
vi.mock('../../src/log/index.js', () => ({
  // 复审-0914-优化修复批：desktop 域错误摘要三目收编 errMsg（同语义假件，保持 mock 面完整）
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  initLogging: () => undefined,
  log: {
    error: (...a: unknown[]) => {
      M_hoisted.logErrors.push(a)
    },
    warn: (...a: unknown[]) => {
      M_hoisted.logWarns.push(a)
    },
    info: (...a: unknown[]) => {
      M_hoisted.logInfos.push(a)
    },
  },
}))
// R54-A-2（五十四轮）：fs/promises stat 闸——失联卷预探超时用例把 stat 挂在手动闸上
//（main.ts 依赖闭包内仅 main.ts 新增 stat 与已被 mock 的 log/index 消费 fs/promises，
// 全量透传 actual 不伤他面）
const fsPromisesMock_hoisted = vi.hoisted(() => ({ statGate: null as null | (() => Promise<never>) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const { statSync } = await import('node:fs')
  return {
    ...actual,
    // 重审-1：缺省路径改 statSync 同步垫底（ok/invalid 语义等价——真实文件系统判定，
    // 不落线程池宏任务）——bootstrap 预探链全微任务化，既有「单次 setImmediate /
    // fake-timer advanceTimersByTimeAsync(0) 即冲刷完 bootstrap」的时序假设保持成立；
    // statGate 手动闸（失联卷挂死形态）语义不变。
    stat: (p: string, o?: Parameters<typeof actual.stat>[1]) => {
      if (fsPromisesMock_hoisted.statGate) return fsPromisesMock_hoisted.statGate()
      return new Promise((resolve, reject) => {
        try {
          resolve(statSync(p, o as Parameters<typeof statSync>[1] | undefined))
        } catch (e) {
          reject(e as Error)
        }
      })
    },
  }
})
vi.mock('font-list', () => ({ getFonts: async () => ['Mock Sans'] }))
// 批 U1：main 不再直调 startServer/setInitialBook（下沉 child），mock 面随之删除

export const tmpDirs: string[] = []
export function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

/** 建书库（.clwriting/books.jsonl 登记 + 可选建书目录与正文文件） */
export function mkLibrary(bookName?: string, bookRel?: string): string {
  const lib = mkTmp('clw-main-lib-')
  mkdirSync(join(lib, '.clwriting'), { recursive: true })
  if (bookName && bookRel) {
    const bookRoot = join(lib, bookRel)
    mkdirSync(bookRoot, { recursive: true })
    writeFileSync(join(bookRoot, '第1章-开篇.md'), '# 第1章\n\n正文')
    writeFileSync(join(lib, '.clwriting', 'books.jsonl'), `${JSON.stringify({ name: bookName, path: bookRel })}\n`)
  }
  return lib
}

// R0916-5b：vi.hoisted 结果不可直接 export（vitest 限制「Cannot export hoisted
// variable」）——普通 const 别名在模块体求值期桥出（hoisted 块先于模块体执行，别名
// 初始化时序安全）；mock 工厂闭包仍锚上方 hoisted 绑定（与原单体文件同构），拆分件
// 按原名义导入 M / fsPromisesMock，用例正文零改动。
export const M = M_hoisted
export const fsPromisesMock = fsPromisesMock_hoisted

// ── R0916-5b 拆分装置：env 前值捕获/还原 + 文件级 beforeAll/afterAll 装置 ──────────
// 原单体文件把 env 前值捕获放在 module 顶层、beforeAll 抬定、afterAll 还原——拆分件
// 侧契约：模块顶层调 captureMainTestEnvPrev()，beforeAll 调 bootstrapMainFixture()，
// afterAll 调 restoreMainTestEnv(prev) + cleanupMainTmpDirs()（顺序与原 afterAll 一致）。

/** 原文件 module 顶层的 env 前值捕获（拆分件在模块顶层调用） */
export interface MainTestEnvPrev {
  initialBook: string | undefined
  recoveryMs: string | undefined
}

export function captureMainTestEnvPrev(): MainTestEnvPrev {
  return {
    initialBook: process.env['CLWRITING_INITIAL_BOOK'],
    recoveryMs: process.env['CLW_SESSION_END_RECOVERY_MS'],
  }
}

/** 原文件 afterAll 的 env 还原 */
export function restoreMainTestEnv(prev: MainTestEnvPrev): void {
  if (prev.initialBook === undefined) delete process.env['CLWRITING_INITIAL_BOOK']
  else process.env['CLWRITING_INITIAL_BOOK'] = prev.initialBook
  if (prev.recoveryMs === undefined) delete process.env['CLW_SESSION_END_RECOVERY_MS']
  else process.env['CLW_SESSION_END_RECOVERY_MS'] = prev.recoveryMs
}

// R50-A-1（五十轮）：session-end 观察窗默认 5s——本域多个用例 emit session-end，若用
// 真定时器默认值，陈旧模块的观察窗会在后续用例执行中途触发并 fork 假 child（污染
// forkChildren 计数/`.at(-1)` 锚定）。文件级抬到 1h 关掉该路径；自愈回归用例自带
// 覆盖（fake timers + 小值注入）。
/**
 * 原文件 beforeAll 装置：env 抬定 + userData/书库夹具 + 持久化预置 + 单次动态导入
 * main.js + whenReady 链冲刷。返回 libA（书库 A 路径，各拆分件用例直接引用）。
 */
export async function bootstrapMainFixture(): Promise<string> {
  delete process.env['CLWRITING_INITIAL_BOOK']
  process.env['CLW_SESSION_END_RECOVERY_MS'] = '3600000'
  M.userData = mkTmp('clw-main-ud-')
  const libA = mkLibrary('书A', 'books/a')
  // 预置持久化 current（合法书库）+ 合法 window-state → bootstrap 走确定路径
  writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: libA, recent: [] }))
  writeFileSync(
    join(M.userData, 'window-state.json'),
    JSON.stringify({ bounds: { x: 50, y: 50, width: 1500, height: 900 } }),
  )
  await import('../../src/desktop/main.js')
  // whenReady 微任务链（CSP 注册 → IPC → 菜单 → bootstrap 假 server listening）冲刷
  await new Promise((r) => setImmediate(r))
  return libA
}

/** 原文件 afterAll 的临时目录回收 */
export function cleanupMainTmpDirs(): void {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
}

export function mainWin(): Record<string, any> {
  const w = M.windows[0]
  expect(w, '主窗口应已创建').toBeTruthy()
  return w as Record<string, any>
}

// R4-P2-1（2026-09-09 修复批）：handler 练习统一走「受信渲染进程」形态——senderFrame
// 须等于 sender.mainFrame（顶层主帧）；null 事件与异帧/白名单外形态属拒绝面（拒绝
// 测试单列）。
// R1010b-DSK-P3-5 适配：sender 白名单收窄为「工厂登记 webContents ∪ 工厂窗反查」后，
// 跨模块实例借用旧窗 sender 的形态不再可信（旧兜底「反查本进程任一存活窗口即放行」
// 掩盖了 resetModules 换实例后仍锚 M.windows[0] 的假绿）。缺省改取最新存活工厂窗——
// 各调用点的当前实例登记窗（fresh module 主窗 / 首实例存活窗），显式传参形态不变。
export function trustedEvent(wc?: Record<string, any>): Record<string, any> {
  const sender =
    wc ?? [...M.windows].reverse().find((w) => !w.isDestroyed())?.webContents ?? mainWin().webContents
  return { sender, senderFrame: sender.mainFrame }
}
