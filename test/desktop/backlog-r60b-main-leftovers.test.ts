/**
 * R60-B（六十轮评审清偿批）：main.ts 两处遗留修复回归。
 *
 * - R60-B-1：主窗 loadURL 无本地 catch——子进程 ready 回传后、首载落定前 server 崩溃
 *   （退避重启窗）的窄竞 rejection 此前直穿 bootstrap reject，onError 只见「启动失败」
 *   一行、缺首载 URL 现场（书架/书库窗 R74-16 均已 .catch 留痕，唯主窗裸奔）。修复 =
 *   补本地 catch 留痕后仍原样上抛：「bootstrap reject → 启动失败 + quit」为固化设计
 *   路径（main.test 时序 2；bootstrap-runner 第九轮 L-3 亦按此失败面设计），本测试
 *   同时锚定两面——本地留痕存在 + reject 契约不被吞。
 * - R60-B-3：saveWinState 的 catch 零留痕（main.ts 全文件唯一无 log 的忽略处）——
 *   窗口状态持久化失败不可见，违全域「失败留痕」纪律。修复 = catch 内补 warn 留痕，
 *   吞错语义不变（窗口状态非关键数据，不阻断关窗/停机链）。
 *
 * 手法：沿用 test/desktop/main.test.ts 的 vi.mock('electron') 全面假件 + 动态 import
 * main.ts 驱动真实 bootstrap（fork 假 child + ready 握手开假窗口）；B-1 经可拒的
 * loadURL 假件构造首载失败（一次性消费旋钮——bootstrap 主窗首载即首个 loadURL 调用，
 * 命中确定性锚定）；B-3 经 isMaximized 抛错构造 saveWinState 失败（session-end 处
 * 注释同款「收尾期 Electron getter 可抛」形态，与 atomicWriteFile 写失败同落一个
 * catch 面，免动真实文件系统）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** mock 状态与捕获面（vi.hoisted 保证 vi.mock 工厂可见） */
const M = vi.hoisted(() => ({
  lock: true,
  userData: '',
  quitCalls: 0,
  relaunchCalls: 0,
  appOn: {} as Record<string, Array<(...a: unknown[]) => void>>,
  headersCb: null as null | ((d: unknown, cb: (r: unknown) => void) => void),
  ipcHandle: {} as Record<string, (e: unknown, ...a: unknown[]) => unknown>,
  dialogOpen: { canceled: true, filePaths: [] as string[] },
  msgResponse: 2,
  msgBoxSyncChoice: 1,
  windows: [] as Array<Record<string, any>>,
  logErrors: [] as unknown[],
  logWarns: [] as unknown[],
  logInfos: [] as unknown[],
  forkCalls: [] as Array<{ modulePath: string; args: string[]; options: Record<string, unknown> }>,
  forkChildren: [] as Array<Record<string, any>>,
  errorBox: [] as Array<[string, string]>,
  /** R60-B-1 旋钮：置位后下一次 BrowserWindow.loadURL 按此值 reject（一次性消费——
   *  修复前该 rejection 直穿 bootstrap reject 无本地留痕，修复后本地 catch 留痕再上抛） */
  rejectNextLoadUrl: null as unknown,
}))

vi.mock('electron', () => {
  class FakeWebContents {
    win: Record<string, any>
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    sent: Array<[string, ...unknown[]]> = []
    reloaded = 0
    constructor(win: Record<string, any>) {
      this.win = win
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
    reload(): void {
      this.reloaded++
    }
    // R44-2：close/before-quit 拦截的渲染层 flush 通道——可配返回值
    //（execJsResult：null=无钩子 / {conflict,failed} 信封）
    execJs: string[] = []
    execJsResult: unknown = null
    executeJavaScript(code: string): Promise<unknown> {
      this.execJs.push(code)
      return Promise.resolve(this.execJsResult)
    }
    // X-26 同款：崩溃提示页 loadURL 委托 win 层记录（本文件未触发，保形不裁）
    loadURL(u: string): Promise<void> {
      return this.win.loadURL(u)
    }
    session = { setProxy: async () => undefined }
  }
  class FakeWin {
    opts: Record<string, any>
    webContents: FakeWebContents
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    closed = false
    focused = 0
    loaded: string[] = []
    maximized = false
    constructor(opts: Record<string, any>) {
      this.opts = opts
      this.webContents = new FakeWebContents(this)
      M.windows.push(this as unknown as Record<string, any>)
    }
    loadURL(u: string): Promise<void> {
      this.loaded.push(u)
      // R60-B-1：可拒首载——置位即一次性消费，reject 该次 loadURL（默认 resolve 不变）
      if (M.rejectNextLoadUrl !== null) {
        const err = M.rejectNextLoadUrl
        M.rejectNextLoadUrl = null
        return Promise.reject(err)
      }
      return Promise.resolve()
    }
    on(evt: string, fn: (...a: unknown[]) => void): void {
      ;(this.handlers[evt] ??= []).push(fn)
    }
    emit(evt: string, ...a: unknown[]): void {
      for (const fn of this.handlers[evt] ?? []) fn(...a)
    }
    focus(): void {
      this.focused++
    }
    close(): void {
      if (this.closed) return
      this.closed = true
      for (const fn of this.handlers['closed'] ?? []) fn()
    }
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
    setMenuBarVisibility(): void {}
  }
  /** utilityProcess 假件（批 U1 形态）：fork 下一拍回传 ready（握手端口 45678）；
   *  shutdown 指令下一拍回执 shutdown-done + exit（正常退出链收口用，本文件未触发） */
  class FakeUtilityProc {
    private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    posted: unknown[] = []
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
      this.posted.push(m)
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
  return {
    app: {
      setPath: (): void => {},
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
        appendSwitch: (): void => {},
      },
      isPackaged: true,
      name: 'CLWriting',
      getAppPath: () => '/fake/app',
    },
    BrowserWindow: Object.assign(class extends FakeWin {}, {
      fromWebContents: (wc: unknown) => M.windows.find((w) => w.webContents === wc) ?? null,
      getAllWindows: () => M.windows,
    }),
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
      buildFromTemplate: () => ({ popup: (): void => {} }),
      setApplicationMenu: () => undefined,
    },
    shell: {
      showItemInFolder: (): void => {},
      openPath: async () => '',
    },
    nativeTheme: { themeSource: 'light' },
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
/** 建合法书库目录（自身含 .clwriting/）——bootstrap 走确定路径（非 welcome 态） */
function mkLibrary(): string {
  const lib = mkTmp('clw-r60b-lib-')
  mkdirSync(join(lib, '.clwriting'), { recursive: true })
  return lib
}

let libA = ''
const prevInitialEnv = process.env['CLWRITING_INITIAL_BOOK']
// 与 main.test.ts 同款：session-end 观察窗抬 1h，防陈旧模块定时器中途触发污染捕获面
const prevRecoveryEnv = process.env['CLW_SESSION_END_RECOVERY_MS']

beforeAll(() => {
  delete process.env['CLWRITING_INITIAL_BOOK']
  process.env['CLW_SESSION_END_RECOVERY_MS'] = '3600000'
  M.userData = mkTmp('clw-r60b-ud-')
  libA = mkLibrary()
  // 预置持久化 current（合法书库）+ 合法 window-state → bootstrap 走确定路径
  writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: libA, recent: [] }))
  writeFileSync(
    join(M.userData, 'window-state.json'),
    JSON.stringify({ bounds: { x: 50, y: 50, width: 1500, height: 900 } }),
  )
})

afterAll(() => {
  if (prevInitialEnv === undefined) delete process.env['CLWRITING_INITIAL_BOOK']
  else process.env['CLWRITING_INITIAL_BOOK'] = prevInitialEnv
  if (prevRecoveryEnv === undefined) delete process.env['CLW_SESSION_END_RECOVERY_MS']
  else process.env['CLW_SESSION_END_RECOVERY_MS'] = prevRecoveryEnv
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

/** 每用例全新 module：模块级状态（mainWindow/storeCache 等）随 resetModules 归零。
 *  就绪信号 = 新 module 的 bootstrap 建出主窗 + 首载完成（窗口计数 +1 且微任务冲刷）。 */
async function freshMain(): Promise<Record<string, any>> {
  vi.resetModules()
  const wins0 = M.windows.length
  await import('../../src/desktop/main.js')
  await vi.waitFor(() => expect(M.windows.length, 'bootstrap 应已建主窗').toBe(wins0 + 1), {
    timeout: 3000,
  })
  await new Promise((r) => setImmediate(r))
  return M.windows.at(-1)!
}

describe('R60-B-1: 主窗首载 loadURL reject——本地留痕 + bootstrap reject 契约保持', () => {
  it('首载 reject → 「主窗口加载失败」留痕（含首载 URL）；rejection 仍冒泡至 onError（启动失败 + quit，时序 2 固化路径不吞）、无未处理拒绝', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const quit0 = M.quitCalls
      const err0 = M.logErrors.length
      const wins0 = M.windows.length
      // 窄竞形态：ready 回传（fork 假件默认 ready）后、首载落定前 server 崩溃——
      // 主窗首载 loadURL reject（一次性消费旋钮，须在 import 前置位）
      M.rejectNextLoadUrl = new Error('ERR_CONNECTION_REFUSED')
      vi.resetModules()
      await import('../../src/desktop/main.js')
      // 首窗已建、首载已发起（FakeWin.loadURL 先记录 URL 再 reject）
      await vi.waitFor(() => expect(M.windows.length).toBe(wins0 + 1), { timeout: 3000 })
      // rejection 链收口：本地留痕 → 上抛 → runner onError →「启动失败」+ quit
      await vi.waitFor(
        () => {
          expect(M.quitCalls, 'onError → app.quit 应已触发').toBeGreaterThan(quit0)
        },
        { timeout: 3000 },
      )
      await new Promise((r) => setImmediate(r))

      const win = M.windows.at(-1)!
      expect(win.loaded[0]).toBe('http://127.0.0.1:45678') // 首载 URL 已发起（留痕现场锚点）

      // 修复点：本地留痕存在——含「主窗口加载失败」与首载 URL（修复前 rejection 直穿，
      // onError 只见「启动失败」一行、缺首载现场）
      const errs = M.logErrors.slice(err0) as unknown[][]
      const trace = errs.find((l) => String(l[1]).includes('主窗口加载失败'))
      expect(trace, '主窗 loadURL reject 应有本地留痕').toBeTruthy()
      expect(trace![0]).toBe('desktop')
      expect(String(trace![1])).toContain('http://127.0.0.1:45678')

      // 契约保持（main.test 时序 2 固化路径）：rejection 仍冒泡至 bootstrap onError——
      // 「启动失败」留痕 + quit；本地 catch 只留痕，不吞
      const bootFail = errs.find((l) => String(l[1]).includes('启动失败'))
      expect(bootFail, 'bootstrap reject → 启动失败 契约不得被本地 catch 吞掉').toBeTruthy()

      // 次序：本地留痕先于 onError（catch 在上抛前）
      expect(errs.indexOf(trace!)).toBeLessThan(errs.indexOf(bootFail!))

      // 全链有主（runner try/catch 兜 onError），无未处理拒绝
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      M.rejectNextLoadUrl = null
    }
  })
})

describe('R60-B-3: saveWinState 持久化失败留痕', () => {
  it('close 链触发 saveWinState 抛错（收尾期 getter 可抛形态）→ warn 留痕含失败原因，且不阻断关窗链', async () => {
    const win = await freshMain()
    const warns0 = M.logWarns.length
    // 收尾期 Electron getter 可抛（main.ts session-end 处注释同款形态）——isMaximized
    // 抛错即落 saveWinState 的 catch 面（与 atomicWriteFile 写失败同 catch，免动真实 FS）
    win.isMaximized = () => {
      throw new Error('Object has been destroyed')
    }
    const e = { preventDefault: vi.fn() }
    expect(() => win.emit('close', e)).not.toThrow() // 吞错语义不变：不向 close 链外抛
    await new Promise((r) => setImmediate(r))

    // 修复点：warn 留痕（修复前 catch 零日志，持久化失败不可见）
    const warns = M.logWarns.slice(warns0) as unknown[][]
    const trace = warns.find((l) => String(l[1]).includes('窗口状态持久化失败'))
    expect(trace, 'saveWinState 失败应 warn 留痕（不再静默吞）').toBeTruthy()
    expect(trace![0]).toBe('desktop')
    expect(String(trace![1])).toContain('Object has been destroyed')

    // 留痕不改变语义：close 链继续（拦下 → 无钩子 flush → destroy 收口）
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(win.isDestroyed(), '关窗链不应被留痕阻断').toBe(true), {
      timeout: 2000,
    })
  })
})
