/**
 * kk-P2-8：Electron 主进程 main.ts 自动化（此前 718 行 0% 覆盖、仅靠人工冒烟）。
 *
 * 手法：vi.mock('electron') 全面假件 + 动态 import main.ts，驱动真实生命周期
 * （whenReady → CSP 注册 → registerIpc → buildMenu → bootstrap 起假 server 开假窗口），
 * 对捕获面断言：
 * - 安全五件套窗口配置（contextIsolation/sandbox/nodeIntegration:false/preload）
 *   + 纵深防御（will-navigate 阻断 / 弹新窗拒绝）+ render-process-gone 自愈
 * - 生产 CSP 注入（default-src 'self' 基线锁定）
 * - 内嵌 server 启动参数（workDir/userDataPath/staticDir/随机端口）与主窗 loadURL
 * - IPC 面：switch-library 校验与持久化、show-in-folder/open-book-dir 路径穿越守卫族、
 *   open-book 导航转发、context-menu 载荷校验与选择回传
 * - 原生菜单模板（生产无 devTools/reload；action click → menu-action 转发）
 * - second-instance --book 直进、window-state 越界丢弃、before-quit 优雅退出幂等、
 *   无单实例锁分支（quit 且不注册生命周期）
 * 灰盒边界：真实模块（workdir-store/install-books/initial-book/graceful-shutdown/
 * context-menu）真实跑；electron/startServer/日志/setInitialBook 为假件。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

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
  msgResponse: 2,
  shell: { show: [] as string[], open: [] as string[] },
  windows: [] as Array<Record<string, any>>,
  focusedWin: null as null | Record<string, any>,
  serverStarts: 0,
  lastServerOpts: null as null | Record<string, unknown>,
  initialBook: null as null | string,
  logErrors: [] as unknown[],
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
      showOpenDialog: async () => M.dialogOpen,
      showMessageBox: async () => ({ response: M.msgResponse }),
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
    warn: () => undefined,
    info: () => undefined,
  },
}))
vi.mock('font-list', () => ({ getFonts: async () => ['Mock Sans'] }))
vi.mock('../../src/studio/server/api/books.js', () => ({
  setInitialBook: (name: string) => {
    M.initialBook = name
  },
}))
vi.mock('../../src/studio/server/index.js', () => ({
  startServer: (opts: Record<string, unknown>) => {
    M.serverStarts++
    M.lastServerOpts = opts
    const s = new EventEmitter() as EventEmitter & { address: () => { port: number }; close: (cb: () => void) => void }
    s.address = () => ({ port: 45678 })
    s.close = (cb: () => void) => cb()
    queueMicrotask(() => s.emit('listening'))
    return s
  },
}))

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

  it('内嵌 server 参数与主窗加载：workDir/userDataPath/staticDir/随机端口 → loadURL', () => {
    expect(M.serverStarts).toBe(1)
    expect(M.lastServerOpts!.workDir).toBe(libA)
    expect(M.lastServerOpts!.userDataPath).toBe(M.userData)
    expect(String(M.lastServerOpts!.staticDir)).toBe(join('/fake/app', 'dist', 'web'))
    expect(mainWin().loaded[0]).toBe('http://127.0.0.1:45678')
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
  it('注册面：10 handle + context-menu on', () => {
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
      'desktop:show-in-folder',
      'desktop:switch-library',
    ].sort())
    expect(M.ipcOn['desktop:context-menu']).toBeTruthy()
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
})

describe('kk-P2-8：退出与边界分支', () => {
  it('before-quit：preventDefault 优雅退出（幂等，二次直通）', async () => {
    const h = M.appOn['before-quit']![0]!
    const e1 = { preventDefault: vi.fn() }
    const q0 = M.quitCalls
    h(e1)
    expect(e1.preventDefault).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(M.quitCalls).toBe(q0 + 1)) // 清理完成后再 quit
    const e2 = { preventDefault: vi.fn() }
    h(e2) // shutdownStarted → 不再拦
    expect(e2.preventDefault).not.toHaveBeenCalled()
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
    const servers0 = M.serverStarts
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
    expect(M.serverStarts).toBe(servers0 + 1) // 仅 fresh bootstrap 的那一次，无重入增量
    expect(M.windows.length).toBe(windows0 + 1) // 无退出途新窗口
  })
})
