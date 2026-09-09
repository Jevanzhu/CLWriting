/**
 * R59 清偿批（R55-A-3）回归：切库落库后退出被取消，workdir.json 回写旧库。
 *
 * 缺陷：三条切库入口（IPC desktop:open-library / desktop:switch-library / 菜单
 * openLibraryAction）都是「先 saveCurrent 持久化新 current，再 relaunch 走 before-quit
 * 优雅退出链」；退出链的冲突/保存失败原生确认一旦被取消（R44-19「取消即中止退出、
 * 应用原样保留」），会话内继续跑旧库，而 workdir.json 已指向新库——跨会话落入
 * 「已被取消」的新库。修复：切库落库前快照 store 作回滚基线，退出取消路径回写；
 * 过不可回头点（armPendingRelaunchIfAny）基线作废。
 *
 * 手法：沿用 test/desktop/main.test.ts 的 vi.mock('electron') 全面假件 + 动态
 * import main.ts 驱动真实 bootstrap；退出取消经 before-quit 假件直接驱动
 * （executeJavaScript 回 {conflict:[...]} 触发原生确认，msgBoxSyncChoice=1 取消），
 * 断言锚点 = workdir.json 落盘内容（行为契约，不钉日志措辞）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** mock 状态与捕获面（vi.hoisted 保证 vi.mock 工厂可见） */
const M = vi.hoisted(() => ({
  lock: true,
  userData: '',
  quitCalls: 0,
  relaunchCalls: 0,
  appOn: {} as Record<string, Array<(...a: unknown[]) => void>>,
  commandLineSwitches: [] as Array<string[]>,
  headersCb: null as null | ((d: unknown, cb: (r: unknown) => void) => void),
  ipcHandle: {} as Record<string, (e: unknown, ...a: unknown[]) => unknown>,
  menuTemplate: null as null | Array<Record<string, unknown>>,
  dialogOpen: { canceled: true, filePaths: [] as string[] },
  msgResponse: 2, // 大小写敏感卷警告等 showMessageBox：非 1 = 不换目录（放行）
  msgBoxSyncChoice: 1, // 冲突/保存失败确认：1 = 取消（「应用原样保留」）
  windows: [] as Array<Record<string, any>>,
  logErrors: [] as unknown[],
  logWarns: [] as unknown[],
  logInfos: [] as unknown[],
  forkCalls: [] as Array<{ modulePath: string; args: string[]; options: Record<string, unknown> }>,
  forkChildren: [] as Array<Record<string, any>>,
  errorBox: [] as Array<[string, string]>,
}))

vi.mock('electron', () => {
  /** utilityProcess 假件：fork 下一拍回传 ready（bootstrap 链放行到 buildMenu）；
   *  shutdown 指令下一拍回执 shutdown-done + exit（正常退出链收口用） */
  class FakeUtilityProc {
    private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    pid = 4242
    stdout = null
    stderr = null
    constructor(modulePath: string, args: string[], options: Record<string, unknown>) {
      M.forkCalls.push({ modulePath, args, options })
      M.forkChildren.push(this as unknown as Record<string, any>)
      queueMicrotask(() => this.emit('message', { type: 'ready', port: 45678 }))
    }
    on(evt: string, fn: (...a: unknown[]) => void): void {
      ;(this.handlers[evt] ??= []).push(fn)
    }
    // server-manager 握手用 once 挂 ready 回执（缺 once → 启动失败炸 bootstrap）
    once(evt: string, fn: (...a: unknown[]) => void): void {
      this.on(evt, fn)
    }
    emit(evt: string, ...a: unknown[]): void {
      for (const fn of [...(this.handlers[evt] ?? [])]) fn(...a)
    }
    postMessage(m: unknown): void {
      if ((m as { type?: string })?.type === 'shutdown') {
        queueMicrotask(() => {
          this.emit('message', { type: 'shutdown-done' })
          this.emit('exit', 0)
        })
      }
    }
    kill(): boolean {
      return true
    }
  }
  class FakeWebContents {
    win: Record<string, any>
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    sent: Array<[string, ...unknown[]]> = []
    // R4-P2-1：顶层主帧 = 自身（isTrustedSender 的 senderFrame === sender.mainFrame 判定形态）
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
      return this.win.closed
    }
    setWindowOpenHandler(): void {}
    // R44-2：close/before-quit 拦截的渲染层 flush 通道——可配返回值
    //（execJsResult：null=无钩子 / {conflict,failed} 信封）
    execJs: string[] = []
    execJsResult: unknown = null
    executeJavaScript(code: string): Promise<unknown> {
      this.execJs.push(code)
      return Promise.resolve(this.execJsResult)
    }
    session = { setProxy: async () => undefined }
  }
  class FakeWin {
    opts: Record<string, any>
    webContents: FakeWebContents
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    closed = false
    loaded: string[] = []
    constructor(opts: Record<string, any>) {
      this.opts = opts
      this.webContents = new FakeWebContents(this)
      M.windows.push(this as unknown as Record<string, any>)
    }
    loadURL(u: string): Promise<void> {
      this.loaded.push(u)
      return Promise.resolve()
    }
    on(evt: string, fn: (...a: unknown[]) => void): void {
      ;(this.handlers[evt] ??= []).push(fn)
    }
    isDestroyed(): boolean {
      return this.closed
    }
    isMaximized(): boolean {
      return false
    }
    // win32 专属：main.ts createSecureWindow 在 win 宿主必调（linux CI 恒不走该
    // 分支，假件此前缺它 → win 上 bootstrap 在 mainWindow 赋值前炸掉、退出链的
    // flush 取消回滚整条失效）。补齐使 win 宿主与 CI 同态。
    setMenuBarVisibility(_visible: boolean): void {}
    getBounds(): Record<string, number> {
      return this.opts as Record<string, number>
    }
    getNormalBounds() {
      return this.getBounds()
    }
    destroy(): void {
      this.closed = true
    }
  }
  return {
    app: {
      setPath: (k: string, v: string) => {
        ;(M as { setPaths?: Record<string, string> }).setPaths = { [k]: v }
      },
      getPath: (k: string) => (k === 'userData' ? M.userData : `/fake/${k}`),
      requestSingleInstanceLock: () => M.lock,
      releaseSingleInstanceLock: () => true,
      on: (evt: string, fn: (...a: unknown[]) => void) => {
        ;(M.appOn[evt] ??= []).push(fn)
      },
      quit: () => {
        M.quitCalls++
      },
      relaunch: () => {
        M.relaunchCalls++
      },
      whenReady: () => Promise.resolve(),
      commandLine: {
        appendSwitch: (...a: string[]) => {
          M.commandLineSwitches.push(a)
        },
      },
      isPackaged: true,
      name: 'CLWriting',
      getAppPath: () => '/fake/app',
    },
    BrowserWindow: FakeWin,
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived: (fn: (d: unknown, cb: (r: unknown) => void) => void) => {
            M.headersCb = fn
          },
        },
      },
    },
    screen: {
      getPrimaryDisplay: () => ({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workAreaSize: { width: 1920, height: 1080 },
      }),
      getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
    },
    ipcMain: {
      handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
        M.ipcHandle[ch] = fn
      },
      on: (): void => {},
    },
    dialog: {
      showOpenDialog: async () => M.dialogOpen,
      showMessageBox: async () => ({ response: M.msgResponse }),
      showMessageBoxSync: () => M.msgBoxSyncChoice,
      showErrorBox: (title: string, msg: string) => {
        M.errorBox.push([title, msg])
      },
    },
    Menu: {
      buildFromTemplate: (t: Array<Record<string, unknown>>) => {
        M.menuTemplate = t
        return { popup: (): void => {} }
      },
      setApplicationMenu: () => undefined,
    },
    nativeTheme: { themeSource: 'light' },
    shell: {
      showItemInFolder: (): void => {},
      openPath: async () => '',
    },
    utilityProcess: {
      fork: (modulePath: string, args: string[], options: Record<string, unknown>) =>
        new FakeUtilityProc(modulePath, args, options),
    },
  }
})

vi.mock('../../src/fs/user-data-path.js', () => ({
  defaultUserDataPath: () => M.userData,
  samePath: (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b,
}))
vi.mock('../../src/log/index.js', () => ({
  initLogging: () => undefined,
  log: {
    error: (...a: unknown[]) => {
      M.logErrors.push(a)
    },
    warn: (...a: unknown[]) => {
      M.logWarns.push(a)
    },
    info: (...a: unknown[]) => {
      M.logInfos.push(a)
    },
  },
}))
vi.mock('font-list', () => ({ getFonts: async () => ['Mock Sans'] }))

const tmpDirs: string[] = []
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
/** 建合法书库目录（自身含 .clwriting/，isLibraryDir/canSwitchLibraryDir 放行） */
function mkLibrary(): string {
  const lib = mkTmp('clw-r55a3-lib-')
  mkdirSync(join(lib, '.clwriting'), { recursive: true })
  return lib
}

const workdirFp = (): string => join(M.userData, 'workdir.json')
/** 读落盘 current（行为契约锚点：workdir.json 内容即跨会话语义） */
function persistedCurrent(): string | null {
  return (JSON.parse(readFileSync(workdirFp(), 'utf-8')) as { current: string | null }).current
}
/** 每用例全新 module：storeCache/pendingRelaunch/quitFlushInFlight/switchRollbackStore
 *  等模块级状态随 resetModules 归零，beforeEach 落盘基线成唯一权威（文件与内存缓存
 *  必然一致）。就绪信号 = 新 module 的 bootstrap 建出主窗（窗口计数 +1）。 */
async function freshMain(): Promise<void> {
  vi.resetModules()
  const wins0 = M.windows.length
  await import('../../src/desktop/main.js')
  // win 慢任务队列（G: 盘 + 排队重的宿主）下 bootstrap 建窗可超默认/3s 窗：
  // 统一放宽到 10s/50ms 轮询。超时到点仍未建窗依旧红，断言语义不弱化。
  await vi.waitFor(() => expect(M.windows.length, 'bootstrap 应已建主窗').toBe(wins0 + 1), {
    timeout: 10_000,
    interval: 50,
  })
  await new Promise((r) => setImmediate(r))
}
// R4-P2-1（2026-09-09 修复批）：handler 直调须带受信渲染进程形态（main.test.ts 同款）
function trustedEvent(): Record<string, unknown> {
  const wc = M.windows.at(-1)!.webContents
  return { sender: wc, senderFrame: wc.mainFrame }
}

/** before-quit 退出链驱动：flush 回 {conflict} 信封 + 确认框选取消，等回写落定 */
async function quitThenCancel(conflict: string[]): Promise<void> {
  const win = M.windows.at(-1)!
  win.webContents.execJsResult = { conflict, failed: [] }
  M.msgBoxSyncChoice = 1 // 取消（「应用原样保留」）
  M.appOn['before-quit']!.at(-1)!({ preventDefault: () => {} })
  // win 慢任务队列下回写落定可超 2s：放宽到 10s/50ms（到点未回写仍红，语义不弱化）
  await vi.waitFor(() => expect(persistedCurrent(), '取消后应回写旧库').toBe(libA), {
    timeout: 10_000,
    interval: 50,
  })
}

let libA = ''

beforeAll(async () => {
  delete process.env['CLWRITING_INITIAL_BOOK']
  M.userData = mkTmp('clw-r55a3-ud-')
  libA = mkLibrary()
  // 预置持久化 current（合法书库）+ 合法 window-state → bootstrap 走确定路径并 buildMenu
  writeFileSync(workdirFp(), JSON.stringify({ current: libA, recent: [] }))
  writeFileSync(
    join(M.userData, 'window-state.json'),
    JSON.stringify({ bounds: { x: 50, y: 50, width: 1500, height: 900 } }),
  )
  await freshMain()
})

afterAll(() => {
  delete process.env['CLWRITING_INITIAL_BOOK']
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  // 基线复位（配合 freshMain：每用例开局持久化面 = current libA 且缓存从文件重建）
  writeFileSync(workdirFp(), JSON.stringify({ current: libA, recent: [] }))
})

/** 菜单模板里的「打开书库目录…」项（openLibraryAction 的唯一生产入口） */
function openLibraryMenuItem(): { click: () => void } {
  const file = M.menuTemplate!.find((m) => (m as { label?: string }).label === '文件') as {
    submenu: Array<Record<string, unknown>>
  }
  const item = file.submenu.find((i) => (i as { label?: string }).label === '打开书库目录…')
  expect(item, '文件菜单应含「打开书库目录…」').toBeTruthy()
  return item as unknown as { click: () => void }
}

describe('R59 清偿批（R55-A-3）: 切库退出被取消 → workdir.json 回写旧库', () => {
  it('缺陷前提：switch-library 落库成功即持久化新库（退出尚未发生）', async () => {
    await freshMain()
    const libB = mkLibrary()
    const r = (await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(persistedCurrent()).toBe(libB) // 落库即时持久化——取消回滚的对象正是这一步
  })

  it('switch-library 切库后退出被取消（冲突确认取消）→ workdir.json 回写旧库', async () => {
    await freshMain()
    const libB = mkLibrary()
    await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)
    expect(persistedCurrent()).toBe(libB)
    await quitThenCancel(['d1'])
    // 修复锚点：取消 = 应用原样保留，跨会话不得落入被取消的新库
    expect(persistedCurrent()).toBe(libA)
  })

  it('switch-library 切库后退出被取消（保存失败确认取消）→ workdir.json 回写旧库', async () => {
    await freshMain()
    const libB = mkLibrary()
    await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)
    expect(persistedCurrent()).toBe(libB)
    // failed 信封走 confirmDiscardFailed 取消点（与冲突取消点同属退出取消路径）
    const win = M.windows.at(-1)!
    win.webContents.execJsResult = { conflict: [], failed: ['d1'] }
    M.msgBoxSyncChoice = 1
    M.appOn['before-quit']!.at(-1)!({ preventDefault: () => {} })
    await vi.waitFor(() => expect(persistedCurrent()).toBe(libA), { timeout: 10_000, interval: 50 })
    expect(persistedCurrent()).toBe(libA)
  })

  it('open-library（IPC）与菜单 openLibraryAction 两入口同样武装回滚：各自切库后取消退出均回写', async () => {
    await freshMain()
    // 入口 2：IPC desktop:open-library（pickLibrary → 落库 → relaunch）
    const libC = mkLibrary()
    M.dialogOpen = { canceled: false, filePaths: [libC] }
    const r = (await M.ipcHandle['desktop:open-library']!(trustedEvent())) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(persistedCurrent()).toBe(libC)
    await quitThenCancel(['d1'])
    expect(persistedCurrent()).toBe(libA)

    // 入口 3：菜单「打开书库目录…」（openLibraryAction，无 {ok,reason} 信封）
    const libD = mkLibrary()
    M.dialogOpen = { canceled: false, filePaths: [libD] }
    openLibraryMenuItem().click()
    await vi.waitFor(() => expect(persistedCurrent()).toBe(libD), { timeout: 10_000, interval: 50 })
    await quitThenCancel(['d1'])
    expect(persistedCurrent()).toBe(libA)
  })

  it('对照：正常退出（确认放弃冲突继续退）→ workdir.json 保持新库，回滚基线在不可回头点作废', async () => {
    await freshMain()
    const libB = mkLibrary()
    await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)
    expect(persistedCurrent()).toBe(libB)
    // 等 RELAUNCH_DELAY_MS（100ms）定时器把切库意图置位（生产时序：quit 晚于落库）
    await new Promise((r) => setTimeout(r, 150))
    // 确认「放弃修改并继续」→ 退出链走到不可回头点：切库意图兑现（武装重启）
    const win = M.windows.at(-1)!
    win.webContents.execJsResult = { conflict: ['d1'], failed: [] }
    M.msgBoxSyncChoice = 0
    M.appOn['before-quit']!.at(-1)!({ preventDefault: () => {} })
    // relaunchCalls 仅由 armPendingRelaunchIfAny 的 app.relaunch 递增，判据确定
    await vi.waitFor(() => expect(M.relaunchCalls).toBeGreaterThan(0), { timeout: 10_000, interval: 50 })
    expect(persistedCurrent()).toBe(libB) // 新库即用户所愿，不回滚
  })
})
