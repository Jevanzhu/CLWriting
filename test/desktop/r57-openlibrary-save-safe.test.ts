/**
 * R57-A-2（五十七轮）回归：菜单链「打开书库目录…」落库失败不再静默。
 *
 * openLibraryAction（菜单文件 → 打开书库目录…）此前裸调 saveCurrent——可抛
 * （磁盘满/权限/只读卷），异常仅被调用点 .catch 记日志，用户点了菜单毫无反馈、
 * 切换静默失败。修复：改走 saveCurrentSafe 契约化包装，失败弹一次性原生错误框
 * （对齐 switch-library 链 saveErr 的失败处理形态）并中止切换（不 relaunch）。
 *
 * 手法：沿用 test/desktop/main.test.ts 的 vi.mock('electron') 全面假件 + 动态
 * import main.ts 驱动真实 bootstrap；落库失败形态 = 把 userData/workdir.json
 * 替换成目录——readStore 走 R47-9 内存缓存不触盘，atomicWriteFile 的 rename
 * 对目录恒 EISDIR（renameWithRetry 只重试瞬态错误，非瞬态即抛），确定性构造
 * 「落库写失败」。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** mock 状态与捕获面（vi.hoisted 保证 vi.mock 工厂可见） */
const M = vi.hoisted(() => ({
  lock: true,
  userData: '',
  quitCalls: 0,
  relaunchCalls: 0,
  appOn: {} as Record<string, Array<(...a: unknown[]) => void>>,
  setPaths: {} as Record<string, string>,
  commandLineSwitches: [] as Array<string[]>,
  headersCb: null as null | ((d: unknown, cb: (r: unknown) => void) => void),
  ipcHandle: {} as Record<string, (e: unknown, ...a: unknown[]) => unknown>,
  windows: [] as Array<Record<string, any>>,
  menuTemplate: null as null | Array<Record<string, unknown>>,
  dialogOpen: { canceled: true, filePaths: [] as string[] },
  msgResponse: 2,
  errorBox: [] as Array<[string, string]>,
  logErrors: [] as unknown[],
  logWarns: [] as unknown[],
  logInfos: [] as unknown[],
  forkCalls: [] as Array<{ modulePath: string; args: string[]; options: Record<string, unknown> }>,
}))

vi.mock('electron', () => {
  /** utilityProcess 假件：fork 下一拍回传 ready（bootstrap 链放行到 buildMenu） */
  class FakeUtilityProc {
    private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    pid = 4242
    stdout = null
    stderr = null
    constructor(modulePath: string, args: string[], options: Record<string, unknown>) {
      M.forkCalls.push({ modulePath, args, options })
      queueMicrotask(() => this.emit('message', { type: 'ready', port: 45678 }))
    }
    on(evt: string, fn: (...a: unknown[]) => void): void {
      ;(this.handlers[evt] ??= []).push(fn)
    }
    // 重审-1：launch 在 ready 后 proc.once('exit') 登记 exit 观察者（server-manager
    // R58-B-1 稳定窗句柄清除）——本假件原先缺 once，bootstrap 在本文件其实一直
    // 静默失败（TypeError → onError quit），仅因失败 quit 恒落在用例 quit 基线快照
    // 之前被掩盖；bootstrap 预探引入真实 IO 后时序位移暴露。补齐让启动链真成功。
    once(evt: string, fn: (...a: unknown[]) => void): void {
      this.on(evt, fn)
    }
    emit(evt: string, ...a: unknown[]): void {
      for (const fn of [...(this.handlers[evt] ?? [])]) fn(...a)
    }
    postMessage(): void {}
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
      return false
    }
    setWindowOpenHandler(): void {}
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
    // 分支，假件此前缺它 → win 上 bootstrap 在 mainWindow 赋值前炸掉，runner 兜底
    // app.quit() 迟落用例窗口打脏 quitCalls 计数）。补齐使 win 宿主与 CI 同态。
    setMenuBarVisibility(_visible: boolean): void {}
    getBounds(): Record<string, number> {
      return this.opts as Record<string, number>
    }
    getNormalBounds() {
      return this.getBounds()
    }
  }
  return {
    app: {
      setPath: (k: string, v: string) => {
        M.setPaths[k] = v
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
    // R4-P2-1：isTrustedSender 兜底反查（白名单外窗口形态）+ 测试侧受信事件构造
    BrowserWindow: Object.assign(class extends FakeWin {}, {
      fromWebContents: (wc: unknown) => M.windows.find((w) => w.webContents === wc) ?? null,
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
      showMessageBoxSync: () => M.msgResponse,
      // R57-A-2 断言锚点：原生错误框捕获面
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
/** 建合法书库目录（自身含 .clwriting/，isLibraryDir 放行） */
function mkLibrary(): string {
  const lib = mkTmp('clw-r57-lib-')
  mkdirSync(join(lib, '.clwriting'), { recursive: true })
  return lib
}

const workdirFp = (): string => join(M.userData, 'workdir.json')

let libA = ''

beforeAll(async () => {
  delete process.env['CLWRITING_INITIAL_BOOK']
  M.userData = mkTmp('clw-r57-ud-')
  libA = mkLibrary()
  // 预置持久化 current（合法书库）+ 合法 window-state → bootstrap 走确定路径并 buildMenu
  writeFileSync(workdirFp(), JSON.stringify({ current: libA, recent: [] }))
  writeFileSync(
    join(M.userData, 'window-state.json'),
    JSON.stringify({ bounds: { x: 50, y: 50, width: 1500, height: 900 } }),
  )
  await import('../../src/desktop/main.js')
  await vi.waitFor(() => expect(M.menuTemplate, 'bootstrap 应已 buildMenu').not.toBeNull())
  await new Promise((r) => setImmediate(r))
})

afterAll(() => {
  delete process.env['CLWRITING_INITIAL_BOOK']
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
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

/** 有界条件轮询：每拍 setImmediate + 50ms 宏任务交替，直到 cond 成立；超时抛错。
 *  取代固定 2×setImmediate 冲刷——win 宿主（G: 盘 + 任务队列重）下点击异步链里
 *  落库 rename 的 EPERM 入 3×50ms 瞬态退避（linux 为 EISDIR 即抛，无此拍），
 *  固定冲刷在链走到断言锚点前就放行。超时到点条件仍未达成依旧红，语义不弱化。 */
async function waitForCond(desc: string, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (cond()) return
    if (Date.now() >= deadline) throw new Error(`条件等待超时（${timeoutMs}ms）：${desc}`)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('R57-A-2: 菜单链「打开书库目录…」落库失败不再静默', () => {
  it('落库成功路径不回归：选库 → 落库 → 触发重启，无原生错误框', async () => {
    const libB = mkLibrary()
    M.dialogOpen = { canceled: false, filePaths: [libB] }
    const box0 = M.errorBox.length
    const quit0 = M.quitCalls
    openLibraryMenuItem().click()
    // 正向完成信号 = app.quit（落库成功才走到 relaunch→quit；失败即中止切换、
    // quit 不发生 → 下方等待超时仍红，断言目标不变）
    await waitForCond('成功链应触发一次 quit', () => M.quitCalls === quit0 + 1)
    // 负断言（零错误框）无法正向等「不出现」：以 quit 为链完成信号后，再冲若干轮
    // 宏任务给「本不该有的错误框」充分暴露窗。取舍：错误框只可能产生于 quit 之前的
    // 落库步（失败即中止、不 quit），quit 已达成即落库已成功，迟达错误框无产生路径，
    // 冲刷仅作纵深防御——极慢宿主上冲刷轮数是下限保证而非全量证明。
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    expect(M.errorBox.length).toBe(box0) // 成功路径零错误框
    // R51-A-1：relaunch() 只记意图 + app.quit()（武装推迟到 before-quit 不可回头点，
    // 本用例不驱动 before-quit）——app.quit 即「已触发切换」的可观测面
    expect(M.quitCalls).toBe(quit0 + 1)
    // 还原 current，避免影响失败用例的 store 缓存基线（写失败形态）
    writeFileSync(workdirFp(), JSON.stringify({ current: libA, recent: [] }))
  })

  it('落库失败（workdir.json 不可写）→ 一次性原生错误框反馈 + 不触发重启（不再静默）', async () => {
    const libB = mkLibrary()
    M.dialogOpen = { canceled: false, filePaths: [libB] }
    // 落库失败形态：workdir.json 替换为目录——readStore 走内存缓存不触盘，
    // atomicWriteFile 的 rename 对目录恒 EISDIR（确定性写失败）
    const backup = readFileSync(workdirFp(), 'utf-8')
    rmSync(workdirFp())
    mkdirSync(workdirFp())
    try {
      const box0 = M.errorBox.length
      const relaunch0 = M.relaunchCalls
      const quit0 = M.quitCalls
      const err0 = M.logErrors.length
      openLibraryMenuItem().click()
      // win 上 rename 对目录抛 EPERM 入 3×50ms 瞬态退避（linux 为 EISDIR 即抛）——
      // 条件等错误框出现（win 专属退避拍 + 慢队列，2s 上限到点未现仍红）
      await waitForCond('落库失败应弹一次性原生错误框', () => M.errorBox.length > box0, 2000)
      // 修复锚点：一次性原生错误框（修复前仅调用点 .catch 记日志，errorBox 零增量）
      expect(M.errorBox.length).toBe(box0 + 1)
      expect(M.errorBox[box0]![0]).toContain('打开书库目录失败')
      expect(M.errorBox[box0]![1]).toContain('落库失败') // saveCurrentSafe 契约文案透传
      // 切换中止：不触发 relaunch/quit（落库失败不得照常重启——否则应用带旧 current
      // 重启，用户操作看起来像被吞）
      expect(M.relaunchCalls).toBe(relaunch0)
      expect(M.quitCalls).toBe(quit0)
      // 留痕仍在（saveCurrentSafe 内部 log.error），但不再是无声失败
      expect(M.logErrors.length).toBeGreaterThan(err0)
      // 落库确未发生：workdir.json 仍是失败形态的目录（写从未成功落回文件态）
      expect(statSync(workdirFp()).isDirectory()).toBe(true)
    } finally {
      // 还原持久化面（目录 → 文件），避免污染（本文件后续无依赖，卫生兜底）
      rmSync(workdirFp(), { recursive: true, force: true })
      writeFileSync(workdirFp(), backup)
    }
  })

  it('IPC desktop:open-library 落库失败对照：同样契约化失败不重启（R51-A-4 既有语义不回归）', async () => {
    const libB = mkLibrary()
    M.dialogOpen = { canceled: false, filePaths: [libB] }
    const backup = readFileSync(workdirFp(), 'utf-8')
    rmSync(workdirFp())
    mkdirSync(workdirFp())
    try {
      const relaunch0 = M.relaunchCalls
      // R4-P2-1：handler 直调须带受信渲染进程形态（main.test.ts 同款）
      const wc = M.windows.at(-1)!.webContents
      const r = (await M.ipcHandle['desktop:open-library']!({ sender: wc, senderFrame: wc.mainFrame })) as {
        ok: boolean
        reason?: string
      }
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('落库失败')
      expect(M.relaunchCalls).toBe(relaunch0)
    } finally {
      rmSync(workdirFp(), { recursive: true, force: true })
      writeFileSync(workdirFp(), backup)
    }
  })
})
