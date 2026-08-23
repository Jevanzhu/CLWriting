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
  whenReadyCalls: 0,
  setPaths: {} as Record<string, string>,
  appOn: {} as Record<string, Array<(...a: unknown[]) => void>>,
  headersCb: null as null | ((d: unknown, cb: (r: unknown) => void) => void),
  ipcHandle: {} as Record<string, (e: unknown, ...a: unknown[]) => unknown>,
  ipcOn: {} as Record<string, (e: unknown, ...a: unknown[]) => void>,
  menuTemplate: null as null | Array<Record<string, unknown>>,
  menuHistory: null as null | Array<Array<Record<string, unknown>>>,
  menuBuilt: 0,
  popupCb: null as null | (() => void),
  dialogOpen: { canceled: true, filePaths: [] as string[] },
  dialogOpenCalls: 0, // E-9c：pickLibrary 循环封顶断言用
  msgResponse: 2,
  shell: { show: [] as string[], open: [] as string[] },
  windows: [] as Array<Record<string, any>>,
  focusedWin: null as null | Record<string, any>,
  logErrors: [] as unknown[],
  logWarns: [] as unknown[], // P3（打包修复批）：second-instance --book 忽略留痕断言用
  logInfos: [] as unknown[],
  // ── 阶段 22 批 U1：utilityProcess 假件捕获面 ──
  forkCalls: [] as Array<{ modulePath: string; args: string[]; options: Record<string, unknown> }>,
  forkChildren: [] as Array<Record<string, any>>,
  /** 'ready'（默认，自动回传 ready 45678）/ 'boot-error'（回传 EADDRINUSE 信封后退出） */
  forkBehavior: 'ready' as 'ready' | 'boot-error',
  errorBox: [] as Array<[string, string]>,
  // ── 阶段 22 批 U3：封顶对话框捕获面（0=重启服务 / 1=退出应用，缺省退出） ──
  msgBoxSync: [] as Array<Record<string, unknown>>,
  msgBoxSyncChoice: 1,
}))

vi.mock('electron', () => {
  class FakeWebContents {
    win: Record<string, any>
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    sent: Array<[string, ...unknown[]]> = []
    windowOpenHandler: ((...a: unknown[]) => { action: string }) | null = null
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
      return false // FakeWin.close 只置 win.closed；webContents 层由各用例自带假件覆盖
    }
    setWindowOpenHandler(fn: () => { action: string }): void {
      this.windowOpenHandler = fn
    }
    reload(): void {
      this.reloaded++
    }
    session = { setProxy: async () => undefined }
  }
  class FakeWin {
    opts: Record<string, any>
    webContents: FakeWebContents
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    focused = 0
    closed = false
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
    focus(): void {
      this.focused++
    }
    close(): void {
      if (this.closed) return
      this.closed = true
      for (const fn of this.handlers['closed'] ?? []) fn()
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
      M.forkCalls.push({ modulePath, args, options })
      M.forkChildren.push(this as unknown as Record<string, any>)
      queueMicrotask(() => {
        if (M.forkBehavior === 'boot-error') {
          this.emit('message', { type: 'boot-error', code: 'EADDRINUSE', message: '端口 0 已被占用（EADDRINUSE），请释放占用进程或用 --port 换端口' })
          this.emit('exit', 1)
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
        M.setPaths[k] = v
      },
      getPath: (k: string) => (k === 'userData' ? M.userData : `/fake/${k}`),
      requestSingleInstanceLock: () => M.lock,
      on: (evt: string, fn: (...a: unknown[]) => void) => {
        ;(M.appOn[evt] ??= []).push(fn)
      },
      quit: () => {
        M.quitCalls++
      },
      relaunch: () => {
        M.relaunchCalls++
      },
      whenReady: () => {
        M.whenReadyCalls++
        return Promise.resolve()
      },
      isPackaged: true,
      name: 'CLWriting',
      getAppPath: () => '/fake/app',
    },
    BrowserWindow: Object.assign(
      class extends FakeWin {},
      {
        fromWebContents: (wc: unknown) =>
          M.windows.find((w) => w.webContents === wc) ?? null,
        getFocusedWindow: () => M.focusedWin,
      },
    ),
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
    },
    ipcMain: {
      handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
        M.ipcHandle[ch] = fn
      },
      on: (ch: string, fn: (e: unknown, ...a: unknown[]) => void) => {
        M.ipcOn[ch] = fn
      },
    },
    dialog: {
      showOpenDialog: async () => {
        M.dialogOpenCalls++ // E-9c：计数（pickLibrary 封顶锚定）
        return M.dialogOpen
      },
      showMessageBox: async () => ({ response: M.msgResponse }),
      showMessageBoxSync: (o: Record<string, unknown>) => {
        M.msgBoxSync.push(o)
        return M.msgBoxSyncChoice
      },
      showErrorBox: (title: string, msg: string) => {
        M.errorBox.push([title, msg])
      },
    },
    Menu: {
      buildFromTemplate: (t: Array<Record<string, unknown>>) => {
        M.menuTemplate = t
        ;(M.menuHistory ??= []).push(t)
        M.menuBuilt++
        return {
          popup: (o: { callback?: () => void }) => {
            M.popupCb = o.callback ?? null
          },
        }
      },
      setApplicationMenu: () => undefined,
    },
    shell: {
      showItemInFolder: (p: string) => {
        M.shell.show.push(p)
      },
      openPath: async (p: string) => {
        M.shell.open.push(p)
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
  defaultUserDataPath: () => M.userData,
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
// 批 U1：main 不再直调 startServer/setInitialBook（下沉 child），mock 面随之删除

const tmpDirs: string[] = []
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

/** 建书库（.clwriting/books.jsonl 登记 + 可选建书目录与正文文件） */
function mkLibrary(bookName?: string, bookRel?: string): string {
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

let libA: string
const prevInitialEnv = process.env['CLWRITING_INITIAL_BOOK']

beforeAll(async () => {
  delete process.env['CLWRITING_INITIAL_BOOK']
  M.userData = mkTmp('clw-main-ud-')
  libA = mkLibrary('书A', 'books/a')
  // 预置持久化 current（合法书库）+ 合法 window-state → bootstrap 走确定路径
  writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: libA, recent: [] }))
  writeFileSync(
    join(M.userData, 'window-state.json'),
    JSON.stringify({ bounds: { x: 50, y: 50, width: 1500, height: 900 } }),
  )
  await import('../../src/desktop/main.js')
  // whenReady 微任务链（CSP 注册 → IPC → 菜单 → bootstrap 假 server listening）冲刷
  await new Promise((r) => setImmediate(r))
})

afterAll(() => {
  if (prevInitialEnv === undefined) delete process.env['CLWRITING_INITIAL_BOOK']
  else process.env['CLWRITING_INITIAL_BOOK'] = prevInitialEnv
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

function mainWin(): Record<string, any> {
  const w = M.windows[0]
  expect(w, '主窗口应已创建').toBeTruthy()
  return w as Record<string, any>
}

describe('kk-P2-8：主进程启动链（安全配置 / CSP / 内嵌 server）', () => {
  it('安全五件套：contextIsolation+sandbox+nodeIntegration:false+preload（ii 批工厂基线）', () => {
    const wp = mainWin().opts.webPreferences
    expect(wp.contextIsolation).toBe(true)
    expect(wp.sandbox).toBe(true)
    expect(wp.nodeIntegration).toBe(false)
    expect(String(wp.preload)).toMatch(/preload\.cjs$/)
    // 资源项：纯中文应用关 Hunspell 词典（每渲染进程几 MB 常驻 + 按键路径开销）
    expect(wp.spellcheck).toBe(false)
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
  it('注册面：11 handle + context-menu on', () => {
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
      'desktop:show-in-folder',
      'desktop:switch-library',
    ].sort())
    expect(M.ipcOn['desktop:context-menu']).toBeTruthy()
  })

  it('set-fullscreen：按发起窗口 setFullScreen(flag===true)，非布尔收敛 false', () => {
    const calls: boolean[] = []
    const wc = { sent: [], on(): void {}, isDestroyed(): boolean { return false } }
    const win = {
      webContents: wc,
      isDestroyed(): boolean { return false },
      setFullScreen(f: boolean): void { calls.push(f) },
    }
    M.windows.push(win as unknown as Record<string, any>)
    M.ipcHandle['desktop:set-fullscreen']!({ sender: wc }, true)
    M.ipcHandle['desktop:set-fullscreen']!({ sender: wc }, false)
    M.ipcHandle['desktop:set-fullscreen']!({ sender: wc }, 'yes')
    expect(calls).toEqual([true, false, false])
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

  it('switch-library：非书库目录拒绝；合法目录持久化 current 并触发 relaunch', async () => {
    const bad = await M.ipcHandle['desktop:switch-library']!(null, mkTmp('not-a-lib-'))
    expect(bad).toEqual({ ok: false, reason: '目录无效或不是书库' })
    const good = mkLibrary()
    const before = M.relaunchCalls
    const r = await M.ipcHandle['desktop:switch-library']!(null, good)
    expect(r).toEqual({ ok: true })
    const stored = JSON.parse(readFileSync(join(M.userData, 'workdir.json'), 'utf8')) as { current: string }
    expect(stored.current).toBe(good)
    // setTimeout(relaunch, 100) 延迟重启——等它生效
    await vi.waitFor(() => expect(M.relaunchCalls).toBeGreaterThan(before))
    // 还原 current，避免影响后续用例的 readStore
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: libA, recent: [] }))
  })

  it('get-current / get-recent：读持久化 store', () => {
    expect(M.ipcHandle['desktop:get-current']!(null)).toBe(libA)
    expect(Array.isArray(M.ipcHandle['desktop:get-recent']!(null))).toBe(true)
  })

  it('show-in-folder 穿越守卫：.. 逃逸 / NUL / 未登记书 全拒；合法路径 realpath 放行', () => {
    const h = M.ipcHandle['desktop:show-in-folder']!
    const n0 = M.shell.show.length
    h(null, '书A', '../escape.md')
    h(null, '书A', '第1章-开篇.md\0evil')
    h(null, '未登记', '第1章-开篇.md')
    h(null, null, 'x')
    expect(M.shell.show.length).toBe(n0)
    h(null, '书A', '第1章-开篇.md')
    expect(M.shell.show.length).toBe(n0 + 1)
    expect(M.shell.show[n0]).toContain('第1章-开篇.md')
  })

  it('show-in-folder 篡改守卫：books.jsonl entry.path 越出 workDir → 拒绝', () => {
    const lib = mkLibrary()
    writeFileSync(join(lib, '.clwriting', 'books.jsonl'), `${JSON.stringify({ name: '坏书', path: '../outside' })}\n`)
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: lib, recent: [] }))
    const n0 = M.shell.show.length
    M.ipcHandle['desktop:show-in-folder']!(null, '坏书', 'any.md')
    expect(M.shell.show.length).toBe(n0)
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: libA, recent: [] }))
  })

  it('open-book-dir 同口径：合法 realpath 放行、越出 workDir 拒绝', () => {
    const n0 = M.shell.open.length
    M.ipcHandle['desktop:open-book-dir']!(null, '书A')
    expect(M.shell.open.length).toBe(n0 + 1)
    expect(M.shell.open[n0]).toContain('books/a')
    const lib = mkLibrary()
    writeFileSync(join(lib, '.clwriting', 'books.jsonl'), `${JSON.stringify({ name: '坏书', path: '../outside' })}\n`)
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: lib, recent: [] }))
    M.ipcHandle['desktop:open-book-dir']!(null, '坏书')
    expect(M.shell.open.length).toBe(n0 + 1)
    writeFileSync(join(M.userData, 'workdir.json'), JSON.stringify({ current: libA, recent: [] }))
  })

  it('open-book：主窗 desktop:navigate 编码转发 + 聚焦', () => {
    const win = mainWin()
    const n0 = win.webContents.sent.length
    M.ipcHandle['desktop:open-book']!(null, '书A')
    const sent = win.webContents.sent[n0]!
    expect(sent[0]).toBe('desktop:navigate')
    expect(sent[1]).toBe(`/book/${encodeURIComponent('书A')}`)
    expect(win.focused).toBeGreaterThan(0)
  })

  it('context-menu：合法载荷建菜单、点选回传 key；非法载荷整体忽略', () => {
    const win = mainWin()
    const sender = win.webContents
    const built0 = M.menuBuilt
    M.ipcOn['desktop:context-menu']!({ sender }, '不是数组')
    expect(M.menuBuilt).toBe(built0)
    M.ipcOn['desktop:context-menu']!({ sender }, [{ label: '复制', key: 'copy', accelerator: 'CmdOrCtrl+C' }])
    expect(M.menuBuilt).toBe(built0 + 1)
    const item = (M.menuTemplate![M.menuTemplate!.length - 1] as { click?: () => void })
    const n0 = win.webContents.sent.length
    item.click!()
    const sent = win.webContents.sent[n0]!
    expect(sent[0]).toBe('desktop:context-menu-select')
    expect(sent[1]).toBe('copy')
  })

  it('N-4（第十二轮）：菜单滞留期间窗口销毁 → click/关闭回调晚到不再向已毁 webContents send', async () => {
    // 独立假窗（不动共享 mainWin——后续用例复用它）：fromWebContents 按 webContents 身份反查
    const wc = {
      sent: [] as Array<[string, ...unknown[]]>,
      on(): void {},
      destroyed: false,
      isDestroyed(): boolean {
        return this.destroyed
      },
    }
    const win = {
      webContents: wc,
      closed: false,
      isDestroyed(): boolean {
        return this.closed
      },
      close(): void {
        this.closed = true
        wc.destroyed = true // webContents 随窗销毁（sendOnce 判 event.sender 本体）
      },
    }
    M.windows.push(win as unknown as Record<string, any>)
    M.ipcOn['desktop:context-menu']!({ sender: wc }, [{ label: '删除', key: 'delete' }])
    const item = (M.menuTemplate![M.menuTemplate!.length - 1] as { click?: () => void })
    win.close() // 菜单仍开着，窗口先关（isDestroyed → true）——点选晚到
    const n0 = wc.sent.length
    // 修复前：对已销毁 webContents send 抛「Object has been destroyed」进主进程
    expect(() => item.click!()).not.toThrow()
    // popup 关闭回调（延后一拍补发 null）同守卫覆盖
    M.popupCb?.()
    await new Promise((r) => setTimeout(r, 5))
    expect(wc.sent.length).toBe(n0) // 两路都无回传
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

  it('second-instance --book 直进：解析登记书 → 主窗导航 + 聚焦', () => {
    const h = M.appOn['second-instance']![0]!
    const win = mainWin()
    const n0 = win.webContents.sent.length
    h({}, ['electron', '--book', '书A'])
    const sent = win.webContents.sent[n0]!
    expect(sent[0]).toBe('desktop:navigate')
    expect(sent[1]).toBe(`/book/${encodeURIComponent('书A')}`)
    expect(win.focused).toBeGreaterThan(0)
  })

  // P3（打包修复批）：启动早期/书未登记时的 --book 忽略路径原为静默——必须留痕
  it('second-instance --book 未匹配登记书：无导航 + info 留痕含书名（不再静默吞）', () => {
    const h = M.appOn['second-instance']![0]!
    const win = mainWin()
    const n0 = win.webContents.sent.length
    const infos0 = M.logInfos.length
    h({}, ['electron', '--book', '不存在的书'])
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
})

describe('kk-P2-8：退出与边界分支', () => {
  it('before-quit：preventDefault 优雅退出（幂等，二次直通）；退出走 shutdown 指令非裸 kill（批 U2）', async () => {
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
    h(e2) // shutdownStarted → 不再拦
    expect(e2.preventDefault).not.toHaveBeenCalled()
  })

  // 批 U3：崩溃风暴接线——manager 退避（默认 0/5s/15s，fake timers 快进）+ main 的
  // 封顶对话框（onRestartExhausted → showMessageBoxSync「重启服务/退出应用」）
  it('崩溃风暴（批 U3）：3 次自动重启后封顶 → 对话框选「退出应用」→ quit 且不再 fork', async () => {
    vi.useFakeTimers()
    try {
      const forks0 = M.forkChildren.length
      const quit0 = M.quitCalls
      M.msgBoxSyncChoice = 1 // 退出应用
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
      expect(M.msgBoxSync.length).toBe(1)
      expect((M.msgBoxSync[0] as { buttons?: string[] }).buttons).toEqual(['重启服务', '退出应用'])
      expect((M.msgBoxSync[0] as { message?: string }).message).toContain('自动重启已停止')
      expect(M.quitCalls).toBeGreaterThan(quit0) // 选退出 → app.quit
    } finally {
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
    expect(win.opts.width).toBe(1532) // min(1532, 1920-80) 默认
    expect(win.opts.height).toBe(1000) // min(1237, 1080-80) 小屏兜底
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
    const r = await M.ipcHandle['desktop:open-library']!(null)
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
    M.forkBehavior = 'ready'
  })
})
