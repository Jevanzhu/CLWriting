/**
 * R61-B-2（六十一轮评审，P3）：readStore 对文件级读失败不容错，可致启动即退。
 *
 * 现状不对称：parseStore 对内容损坏已容错（返回 undefined 走默认）、loadWinState 对
 * 整个读过程 catch-all，唯 readFileSync 本身抛错（workdir.json 权限 EACCES、杀毒/
 * 同步盘瞬时锁）无人捕获 → bootstrap 首行 readStore() 裸抛 → 「启动失败」退出。
 * 修复 = readFileSync 单独 try/catch：读失败按「无存储」降级（与 parseStore 失败
 * 同款形态——缓存 emptyStore，下次调用不再重读）+ warn 留痕（文案带路径与错误信息）。
 *
 * 手法：沿用 main.test.ts / backlog-r60b 的 vi.mock('electron') 全面假件 + 动态 import
 * main.ts 驱动真实 bootstrap。「文件级读失败」用 workdir.json 同名目录替换构造
 * （readFileSync 必抛 EISDIR；chmod 0o000 在 root/Windows 下不可靠，选跨平台最稳手段，
 * 同 R51-A-4 breakStoreFile 先例）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
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
}))

vi.mock('electron', () => {
  class FakeWebContents {
    win: Record<string, any>
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    sent: Array<[string, ...unknown[]]> = []
    reloaded = 0
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
    reload(): void {
      this.reloaded++
    }
    execJs: string[] = []
    execJsResult: unknown = null
    executeJavaScript(code: string): Promise<unknown> {
      this.execJs.push(code)
      return Promise.resolve(this.execJsResult)
    }
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
  /** utilityProcess 假件（批 U1 形态）：fork 下一拍回传 ready（握手端口 45678） */
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
/** 建合法书库目录（workdir.json 的 current 指向它，内容本身在本组用例中不被读达） */
function mkLibrary(): string {
  const lib = mkTmp('clw-r61b2-lib-')
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
  M.userData = mkTmp('clw-r61b2-ud-')
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

/**
 * 把 workdir.json 替换成同名目录：existsSync 仍为真（目录存在），readFileSync 必抛
 * EISDIR——「文件级读失败」（权限/瞬时锁同落此 catch 面）的跨平台最稳构造。返回还原
 * 函数（幂等：可重复调用）。
 */
function breakStoreFile(): () => void {
  const fp = join(M.userData, 'workdir.json')
  const raw = readFileSync(fp, 'utf-8')
  rmSync(fp)
  mkdirSync(fp)
  return () => {
    rmSync(fp, { recursive: true, force: true })
    writeFileSync(fp, raw)
  }
}

/** 每用例全新 module：模块级状态（storeCache 等）随 resetModules 归零，读失败路径重新首读 */
async function freshMain(): Promise<void> {
  vi.resetModules()
  const wins0 = M.windows.length
  await import('../../src/desktop/main.js')
  await vi.waitFor(() => expect(M.windows.length, 'bootstrap 应已建主窗').toBe(wins0 + 1), {
    timeout: 3000,
  })
  await new Promise((r) => setImmediate(r))
}

describe('R61-B-2: readStore 文件级读失败降级（不再启动即退）', () => {
  it('workdir.json 不可读（EISDIR）→ 应用正常启动（主窗就位、不 quit、无「启动失败」）+ warn 留痕含路径与错误信息', async () => {
    const restore = breakStoreFile()
    const wins0 = M.windows.length
    const quit0 = M.quitCalls
    const errs0 = M.logErrors.length
    const warns0 = M.logWarns.length
    try {
      await freshMain()

      // 修复点 1：读失败按无存储降级 → bootstrap 链不抛错，主窗照常就位
      //（修复前 readFileSync 裸抛 → bootstrap reject → 「启动失败」+ quit，主窗永不出现）
      expect(M.windows.length).toBe(wins0 + 1)
      expect(M.quitCalls, '读失败不得触发退出').toBe(quit0)
      expect(
        M.logErrors.slice(errs0).some((l) => String((l as unknown[])[1]).includes('启动失败')),
        '不得出现「启动失败」error',
      ).toBe(false)

      // 修复点 2：warn 留痕（文案带路径与错误信息，风格对齐同文件其他 warn）
      const warns = M.logWarns.slice(warns0) as unknown[][]
      const trace = warns.find((l) => String(l[1]).includes('workdir.json'))
      expect(trace, '读失败应 warn 留痕（不再静默）').toBeTruthy()
      expect(trace![0]).toBe('desktop')
      expect(String(trace![1])).toContain(join(M.userData, 'workdir.json')) // 带路径
      expect(String(trace![1]).length).toBeGreaterThan(join(M.userData, 'workdir.json').length) // 路径之外还有原因
    } finally {
      restore()
      vi.resetModules()
    }
  })

  it('降级缓存语义与 parseStore 失败同款——不再重读：恢复真身文件后 get-recent 仍空、无二次 warn', async () => {
    const restore = breakStoreFile()
    try {
      await freshMain()
      const warns0 = M.logWarns.length
      restore() // 恢复真身（current=libA）：若读失败路径会重读，此处将读到非空 recent/current
      // R4-P2-1：handler 直调须带受信渲染进程形态（main.test.ts 同款）
      const wc = M.windows.at(-1)!.webContents
      const recent = M.ipcHandle['desktop:get-recent']!({ sender: wc, senderFrame: wc.mainFrame }, {}) as Array<{ path: string }>
      expect(recent, '降级缓存命中：不再重读（parseStore 失败路径同款语义）').toEqual([])
      expect(M.logWarns.length, '缓存命中零盘 IO：无二次读 → 无二次 warn').toBe(warns0)
    } finally {
      restore()
      vi.resetModules()
    }
  })
})
