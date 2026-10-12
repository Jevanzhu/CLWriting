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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** mock 状态与捕获面（vi.hoisted 保证 vi.mock 工厂可见） */
const M = vi.hoisted(() => ({
  lock: true,
  userData: '',
  quitCalls: 0,
  relaunchCalls: 0,
  relaunchArgs: [] as unknown[], // 多库多窗 §4.4：relaunch({args}) 清洗面
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
      relaunch: (opts?: unknown) => {
        M.relaunchCalls++
        M.relaunchArgs.push(opts ?? null)
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
      // 阶段 53 S2：main 启动链读版本号经 env 下发（假件给固定版号）
      getVersion: () => '0.0.0-fake',
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
  // 多库多窗：共享根 / 实例目录 / instanceKey（假件按真实现形状给值）
  appDataHomeDir: () => M.userData,
  instanceUserDataPath: (key: string) => `${M.userData}/instances/${key}`,
  WELCOME_INSTANCE_KEY: 'welcome',
  libraryInstanceKey: (dir: string) => `key-${Buffer.from(dir).toString('hex').slice(0, 12)}`,
  samePath: (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b),
}))
vi.mock('../../src/log/index.js', () => ({
  // 复审-0914-优化修复批：desktop 域错误摘要三目收编 errMsg（同语义假件，保持 mock 面完整）
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
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

describe('多库多窗：workdir.json 跨进程合并（G3）与 relaunch argv 清洗（§4.4）', () => {
  it('G3：锁内以盘上真身为基底重放 setCurrent——他实例并发写入的 recent 不丢', async () => {
    await freshMain() // 缓存从基线（current libA、recent 空）重建
    const libB = mkLibrary()
    const libC = mkLibrary()
    // 模拟另一实例（另一窗口）并发落盘：盘上新增 recent 条目 C——本实例内存缓存不知情；
    // 修复前 writeStore 按内存整份覆盖，C 随本实例下一次切库被抹掉
    writeFileSync(workdirFp(), JSON.stringify({ current: libA, recent: [{ path: libC, label: 'C' }] }))
    const r = (await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)) as { ok: boolean }
    expect(r.ok).toBe(true)
    const disk = JSON.parse(readFileSync(workdirFp(), 'utf-8')) as {
      current: string | null
      recent: Array<{ path: string }>
    }
    expect(disk.current).toBe(libB)
    const paths = disk.recent.map((x) => x.path)
    expect(paths, '他实例写入的 recent 条目不得被覆盖丢失').toContain(libC)
    expect(paths, '旧 current 按 setCurrent 语义入 recent 头部').toContain(libA)
  })

  it('G3：盘上读失败（EISDIR）时拒绝覆写并契约化失败，不静默裸写', async () => {
    await freshMain()
    const libB = mkLibrary()
    // workdir.json 换成同名目录（EISDIR：非 ENOENT 读失败）——锁内重读失败 → 拒绝写入
    rmSync(workdirFp(), { force: true })
    mkdirSync(workdirFp(), { recursive: true })
    const r = (await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)) as {
      ok: boolean
      reason?: string
    }
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('保护历史记录')
    rmSync(workdirFp(), { recursive: true, force: true })
  })

  it('§4.4：切库 relaunch 的 argv 已清 --dir（不清会把切换目标顶回旧库）', async () => {
    const argvLen = process.argv.length
    // 模拟「本实例由 --dir 拉起」（spawn 新窗口形态）：argv 带 --dir libA
    process.argv.push('--dir', libA)
    try {
      await freshMain() // 顶层启动解析按 --dir 派生 key（不炸）
      const libB = mkLibrary()
      await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)
      expect(persistedCurrent()).toBe(libB)
      await new Promise((r) => setTimeout(r, 150))
      const win = M.windows.at(-1)!
      win.webContents.execJsResult = { conflict: [], failed: [] }
      M.msgBoxSyncChoice = 0
      M.appOn['before-quit']!.at(-1)!({ preventDefault: () => {} })
      await vi.waitFor(() => expect(M.relaunchCalls).toBeGreaterThan(0), { timeout: 10_000, interval: 50 })
      const opts = M.relaunchArgs.at(-1) as { args?: string[] } | null
      expect(opts?.args, 'relaunch 须显式传清洗后的 argv').toBeTruthy()
      expect(opts!.args, '--dir 及其值必须摘除').not.toContain('--dir')
      expect(opts!.args).not.toContain(libA)
    } finally {
      process.argv.length = argvLen
    }
  })
})

// ── 多库多窗：取消回滚按锁内读-改-合并（不按快照整写）────────────────────
// 缺陷：回滚按「先前读到的快照」整份写回 workdir.json，其中快照 current 为 null 的
// 形态（welcome 态切库后取消退出）不做任何盘上合并——「读快照 → 回滚写回」窗口内
// 另一实例（同机另一库窗口，共享根 workdir.json）新增的 recent 条目被静默抹掉。
// 修复：回滚写走锁内读-改-合并（workdir-store.rollbackStore），保留盘上「本实例不知情」
// 的条目，current 仍只认快照。断言面 = workdir.json 落盘内容（not 私有调用序）。
describe('多库多窗：切库取消回滚的锁内合并', () => {
  const workdirFpLocal = (): string => join(M.userData, 'workdir.json')
  /** 读整份落盘 store（回滚合并的观察面） */
  function persistedStore(): { current: string | null; recent: Array<{ path: string; label: string }> } {
    return JSON.parse(readFileSync(workdirFpLocal(), 'utf-8')) as {
      current: string | null
      recent: Array<{ path: string; label: string }>
    }
  }
  /** 退出链取消驱动（不看 current 终值，由调用方断言；用于 welcome 态快照等形态） */
  async function quitCancel(): Promise<void> {
    const win = M.windows.at(-1)!
    win.webContents.execJsResult = { conflict: ['d1'], failed: [] }
    M.msgBoxSyncChoice = 1 // 取消（「应用原样保留」）
    M.appOn['before-quit']!.at(-1)!({ preventDefault: () => {} })
    // 回滚是异步链（flush → 确认 → 回写）：等回写落定的可观测信号由调用方轮询
    await new Promise((r) => setImmediate(r))
  }

  it('welcome 态快照（current=null）回滚：他实例窗口内新增的 recent 条目保留，current 回到 null', async () => {
    // 快照 current=null（welcome 态）——须在 freshMain 前落盘，缓存才按它重建
    const libR = mkLibrary()
    writeFileSync(workdirFp(), JSON.stringify({ current: null, recent: [{ path: libR, label: 'R' }] }))
    await freshMain()
    const libB = mkLibrary()
    const libC = mkLibrary()
    const r = (await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(persistedCurrent()).toBe(libB) // welcome 态切库：无旧 current 可顶入 recent
    // 另一实例在「快照读取 → 回滚写回」窗口内落盘 recent 新增（本实例缓存不知情）
    writeFileSync(workdirFp(), JSON.stringify({ current: libB, recent: [{ path: libR, label: 'R' }, { path: libC, label: 'C' }] }))
    await quitCancel()
    await vi.waitFor(() => expect(persistedCurrent()).toBeNull(), { timeout: 10_000, interval: 50 })
    // 修复锚点：他实例新增条目不得被快照整写抹掉；快照侧条目照常复位
    expect(persistedStore().recent).toEqual([
      { path: libC, label: 'C' },
      { path: libR, label: 'R' },
    ])
  })

  it('无并发（welcome 态快照）回滚：落盘与快照逐位一致（单实例零差异）', async () => {
    const libR = mkLibrary()
    writeFileSync(workdirFp(), JSON.stringify({ current: null, recent: [{ path: libR, label: 'R' }] }))
    await freshMain()
    const libB = mkLibrary()
    await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)
    expect(persistedCurrent()).toBe(libB)
    const before = readFileSync(workdirFp(), 'utf-8')
    expect(before).not.toContain('null') // 切换确已落库（回滚有物可回）
    await quitCancel()
    await vi.waitFor(() => expect(persistedCurrent()).toBeNull(), { timeout: 10_000, interval: 50 })
    expect(readFileSync(workdirFp(), 'utf-8')).toBe(
      JSON.stringify({ current: null, recent: [{ path: libR, label: 'R' }] }, null, 2) + '\n',
    )
  })

  it('回滚期盘上文件读失败（非 ENOENT）→ 拒绝回写、不吞错：留痕 + 盘面未被覆写', async () => {
    const libR = mkLibrary()
    writeFileSync(workdirFp(), JSON.stringify({ current: null, recent: [{ path: libR, label: 'R' }] }))
    await freshMain()
    const libB = mkLibrary()
    await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)
    expect(persistedCurrent()).toBe(libB)
    // 回滚期把 workdir.json 换成同名目录（EISDIR：非 ENOENT 读失败）→ 既有分诊口径 = 拒绝覆写
    rmSync(workdirFp(), { force: true })
    mkdirSync(workdirFp(), { recursive: true })
    try {
      const err0 = M.logErrors.length
      await quitCancel()
      await vi.waitFor(() => expect(M.logErrors.length).toBeGreaterThan(err0), { timeout: 10_000, interval: 50 })
      // 拒绝覆写：盘上目录原样（未被 rename 顶成文件），失败经既有留痕路径暴露而非吞掉
      expect(statSync(workdirFp()).isDirectory()).toBe(true)
      expect(M.logErrors.some((l) => String((l as unknown[])[1]).includes('已拒绝回写'))).toBe(true)
      expect(M.logErrors.some((l) => String((l as unknown[])[1]).includes('回写失败'))).toBe(true)
    } finally {
      rmSync(workdirFp(), { recursive: true, force: true })
      writeFileSync(workdirFp(), JSON.stringify({ current: libA, recent: [] }))
    }
  })
})

// ── 切库落库的锁等待不阻塞主进程事件循环 ───────────────────────────────
// 缺陷形态：writeStore 的跨进程写锁走同步孪生（acquireCrossProcessLockWithTimeout
// 内部 Atomics.wait）——他实例（或跨提权持有者）占锁期间，desktop:open-library /
// desktop:switch-library 两个 IPC handler 与其上游菜单/退出取消回写都在主进程事件
// 循环上同步睡，最坏等满写锁超时档：三窗口界面、全部 IPC、退出链确认一齐冻结。
// 修后：锁等待走异步孪生（setTimeout 轮询），等待期事件循环照常让出；
// 「等不到即按超时契约化失败」的判据与返回形状逐条不变。
// 断言面 = 可让出性（等待期定时器照跑）+ 契约回执（ok:false + 超时文案）+ 盘面终态，
// 不钉日志措辞；超时档经测试注入短档（见 WORKDIR_WRITE_LOCK_TIMEOUT_MS 处锚注）。
describe('切库落库：锁被持有期间主进程事件循环可让出', () => {
  const lockFp = (): string => `${workdirFp()}.lock`

  it('desktop:switch-library：锁被持有 → 等待期定时器照跑（让出事件循环）、超时回契约化失败，释放后重试成功', async () => {
    await freshMain()
    // 生效超时档缩短到 250ms（生产 5s 档不改）——本用例要观察的是「等待方式」而不是
    // 「等多久」，短档让红/绿都快速落定
    const ctl = await import('../../src/desktop/workdir-controller.js')
    const { tryAcquireCrossProcessLock } = await import('../../src/fs/cross-process-lock.js')
    ctl.__setWorkdirWriteLockTimeoutForTest(250)
    // 本进程持锁（pid 存活 → 对任何取锁者判 held）——等价他实例正在写共享根
    const release = tryAcquireCrossProcessLock(lockFp())
    if (!release) throw new Error('前置：无争用下占锁失败')
    const libB = mkLibrary()
    let ticks = 0
    const ticker = setInterval(() => {
      ticks++
    }, 20)
    let r: { ok: boolean; reason?: string } | null = null
    const t0 = Date.now()
    try {
      r = (await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)) as { ok: boolean; reason?: string }
    } finally {
      clearInterval(ticker)
      release()
    }
    expect(r.ok).toBe(false)
    // 契约化失败回执（writeStore 的超时人话原因经 saveCurrentSafe 包装透出，
    // 与同步取锁版逐字同源）
    expect(r.reason).toContain('正被其他窗口写入')
    // 关键可观察面：等待期事件循环未被停住——同步实现下此处恒为 0
    expect(ticks).toBeGreaterThan(0)
    // 超时预算被如实用满（不是靠悄悄缩短等待来「消除阻塞」）：250ms 档下
    // 取锁必须至少在位等到大致该时长才判超时。下界断言（留 100ms 宽松余量）。
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150)
    // 失败不落库（盘面仍是原 current）
    expect(persistedCurrent()).toBe(libA)
    // 锁释放后同一入口重试 → 成功落库（超时失败不是死路）
    const retry = (await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)) as { ok: boolean }
    expect(retry.ok).toBe(true)
    expect(persistedCurrent()).toBe(libB)
  })

  it('退出取消回写同样走异步等待：锁被持有期间事件循环照常让出，锁一释放回写即落定', async () => {
    await freshMain()
    const ctl = await import('../../src/desktop/workdir-controller.js')
    const { tryAcquireCrossProcessLock } = await import('../../src/fs/cross-process-lock.js')
    // 预算放宽到 1.5s：本用例要在「回写正等待」的窗口内释放锁，短档会让等待窗
    // 与用例自身的等待相撞（生产 5s 档不改）
    ctl.__setWorkdirWriteLockTimeoutForTest(1_500)
    // 先正常切库（落库成功 → 武装回滚基线），再占锁后驱动退出取消
    const libB = mkLibrary()
    await M.ipcHandle['desktop:switch-library']!(trustedEvent(), libB)
    expect(persistedCurrent()).toBe(libB)
    const release = tryAcquireCrossProcessLock(lockFp())
    if (!release) throw new Error('前置：无争用下占锁失败')
    let ticks = 0
    const ticker = setInterval(() => {
      ticks++
    }, 20)
    try {
      const win = M.windows.at(-1)!
      win.webContents.execJsResult = { conflict: ['d1'], failed: [] }
      M.msgBoxSyncChoice = 1 // 取消（「应用原样保留」）
      M.appOn['before-quit']!.at(-1)!({ preventDefault: () => {} })
      // 等事件循环跑过几拍（约 100ms）——此刻回写仍在等待窗内（预算 1.5s）：
      // 同步实现下这几拍不可能跑起来（主进程被 Atomics.wait 占住）
      await vi.waitFor(() => expect(ticks).toBeGreaterThanOrEqual(5), { timeout: 5_000, interval: 20 })
      // 占锁解除 → 在途的异步回写应当拿到锁并把盘面写回旧库（无需新一次退出链动作）
      release()
      await vi.waitFor(() => expect(persistedCurrent()).toBe(libA), { timeout: 10_000, interval: 20 })
    } finally {
      clearInterval(ticker)
      release()
    }
    expect(ticks, '等待期定时器照跑（同步实现下此处恒为 0）').toBeGreaterThan(0)
  })
})
