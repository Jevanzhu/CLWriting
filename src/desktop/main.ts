/**
 * Electron 主进程入口（桌面化 #electron）。
 *
 * 起 studio server（复用 src/studio/server，127.0.0.1 随机端口）→ BrowserWindow loadURL。
 * 前端 Vue 零改造（fetch /api/...）；driver 复用（与 CLI/Web 同源：cc 驱动 spawn claude，provider 线走 HTTP）。
 *
 * 工作目录（书库）管理（批2 起）：
 * - 启动定位：userData 持久化的 current（合法则用）> findWorkDir(cwd) > 弹原生选择器。
 * - 切换书库 = 改持久化 current → app.relaunch() 进程重启
 *   （规避 server 路由模块级单例 + SSE 长连接泄漏，见 Dev/Plans/desktop-workdir-方案.md §2.1/§3.1）。
 *
 * 开发：npm run dev:electron（build:web + tsup + electron .）
 * 打包：electron-builder（dist/web + dist/desktop/{main,preload}.js 进 asar）
 */
import {
  app,
  BrowserWindow,
  session,
  screen,
  ipcMain,
  dialog,
  Menu,
  shell,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type MessageBoxOptions,
  type BrowserWindowConstructorOptions,
} from 'electron'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import type { Server } from 'node:http'
import { startServer } from '../studio/server/index.js'
import { setInitialBook } from '../studio/server/api/books.js'
import { findWorkDir, readBooks } from '../install/books.js'
import { atomicWriteFile } from '../fs/atomic.js'
import { resolveWithinRoot } from '../fs/safe-path.js'
import { defaultUserDataPath } from '../fs/user-data-path.js'
import { initialBookArg, resolveInitialBook } from './initial-book.js' // RB-SV-P2-4：--book 直进
import { parseContextMenuSpecs, type ContextMenuSpec } from './context-menu.js' // RB-SV-P2-5：IPC 载荷净化
import { shutdownStudio } from './graceful-shutdown.js' // RB-SV-P2-6：优雅退出
import { getFonts as getSystemFontList } from 'font-list'
import {
  parseStore,
  setCurrent,
  filterValidRecent,
  serializeStore,
  emptyStore,
} from './workdir-store.js'
import type { WorkDirStore } from './workdir-store.js'
import { initLogging, log } from '../log/index.js'

const here = dirname(fileURLToPath(import.meta.url)) // dist/desktop/

/** 生产模式 CSP：限定所有资源走本地 origin，防渲染层注入外部脚本/样式 */
const CLW_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // CodeMirror / Vue 动态样式注入
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'", // 只连本地 server（SSE + fetch）
].join('; ')

// userData 强制统一到定值（大写 CLWriting）。
// Electron 默认目录名跟随 app.name——dev（package.json name=clwriting）与打包
// （electron-builder productName=CLWriting）大小写不一致，macOS/Windows 大小写不敏感
// 侥幸同目录，Linux 上会分裂成两个目录导致配置不互通。见 src/fs/user-data-path.ts。
// 必须在 app.getPath('userData') 首次调用（如下方 stateFile）之前执行。
app.setPath('userData', defaultUserDataPath())
// A4（批 0）：结构化日志——打包态 console 无人看见，尽早切到 JSONL 落盘
// （userData/logs/app-YYYYMMDD.jsonl）；dev 态保留 console 镜像。后续 startServer
// 会再 init 一次（幂等，参数一致）。
initLogging({ logsDir: join(app.getPath('userData'), 'logs'), mirrorConsole: !app.isPackaged })

// Z-P2-8 单实例锁：双开实例会对同一 userData 的 workdir.json / window-state.json
// 读改写互踩（atomic 写只防文件撕裂，防不了语义层竞态）。锁须在 setPath 之后请求，
// 保证 dev/打包两种形态落在同一 userData 上（否则锁会各自为政形同虚设）。
// 第二实例拿不到锁 → app.quit() 并跳过文件底部全部生命周期注册（不进 whenReady、
// 不起 server、不开窗）；持锁实例收到 second-instance 时聚焦已有主窗口。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv: string[]) => {
    // RB-SV-P2-4：第二实例带 --book → 主窗口直达该书（与 desktop:open-book 同通路）
    const workDir = currentWorkDir() // M-3（第八轮）：bootstrap 实际值优先
    const ref = initialBookArg(argv)
    if (workDir && ref && mainWindow && !mainWindow.isDestroyed()) {
      const name = resolveInitialBook(workDir, ref)
      if (name) mainWindow.webContents.send('desktop:navigate', `/book/${encodeURIComponent(name)}`)
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus()
  })
}

/** 前端静态目录：打包后 asar 内 / 开发项目根 dist/web */
function resolveStaticDir(): string {
  return app.isPackaged
    ? join(app.getAppPath(), 'dist', 'web') // 打包：app.asar/dist/web
    : resolve(here, '..', '..', 'dist', 'web') // 开发：here=dist/desktop/ → 项目根/dist/web
}

let mainWindow: BrowserWindow | null = null
let shelfWindow: BrowserWindow | null = null
let libraryWindow: BrowserWindow | null = null
let appUrl = '' // 主窗口加载的 url（dev:5173 / packaged server）；书架窗口复用
let studioServer: Server | null = null // 内嵌 server（dev HMR 态为 null）
/** P5-服务端（第七轮）：bootstrap 实际采用的 workDir——before-quit 优雅退出回读用
 *  （readStore().current 可能为 null/失效而实际 workDir 由 findWorkDir 发现） */
let bootstrappedWorkDir: string | null = null

/** M-3（第八轮）：桌面侧统一取「实际运行的书库」——bootstrap 实际采用的 workDir 优先，
 *  store 回读兜底。P5-服务端（第七轮）只修了 before-quit 一点；second-instance --book、
 *  show-in-folder、open-book-dir、open-library-dir 四个入口仍单读 readStore().current，
 *  store.current 为 null/失效而实际跑在 findWorkDir 发现的书库上时全部静默失明。 */
function currentWorkDir(): string | null {
  return bootstrappedWorkDir ?? readStore().current
}

/** 主窗口 bounds 持久化（userData/window-state.json）：关闭时存，启动时恢复。 */
const stateFile = join(app.getPath('userData'), 'window-state.json')
interface WinState {
  bounds: { x: number; y: number; width: number; height: number }
  maximized?: boolean
}
function loadWinState(): WinState | null {
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf-8')) as WinState
    const wa = screen.getPrimaryDisplay().bounds
    // 校验 bounds 有效且在屏幕可见区内（避免恢复到屏幕外 / 多屏拔除后坐标失效）
    const { x, y, width, height } = s.bounds
    if (
      width >= 1200 && height >= 760 &&
      x >= wa.x - 200 && y >= wa.y - 200 &&
      x + width <= wa.x + wa.width + 200 &&
      y + height <= wa.y + wa.height + 200
    ) return s
  } catch {
    /* 无文件或损坏 → 默认 */
  }
  return null
}
function saveWinState(): void {
  if (!mainWindow) return
  try {
    const maximized = mainWindow.isMaximized()
    // 最大化时存正常（非最大化）bounds，恢复时按 maximized 标志决定是否最大化
    const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    atomicWriteFile(stateFile, JSON.stringify({ bounds, maximized }))
  } catch {
    /* 忽略 */
  }
}

// ── 工作目录持久化（userData/workdir.json）──────────────

/** 持久化文件路径（Electron userData 目录）。 */
function storePath(): string {
  return join(app.getPath('userData'), 'workdir.json')
}

/** 读 store（含失效 recent 清理）；缺失/损坏 → 空存储。 */
function readStore(): WorkDirStore {
  const fp = storePath()
  if (!existsSync(fp)) return emptyStore()
  return filterValidRecent(parseStore(readFileSync(fp, 'utf-8')))
}

/** 原子写 store。 */
function writeStore(store: WorkDirStore): void {
  atomicWriteFile(storePath(), serializeStore(store))
}

/** 设新 current（旧入 recent）+ 持久化。 */
function saveCurrent(dir: string): void {
  writeStore(setCurrent(readStore(), dir))
}

/** 是否合法书库目录（自身含 .clwriting/）。复用 findWorkDir 的判定。 */
function isLibraryDir(dir: string): boolean {
  return findWorkDir(dir) === resolve(dir)
}

// ── 目录选择 + 切换 ────────────────────────────────────

/**
 * 弹原生目录选择器选书库。批2：仅接受含 .clwriting/ 的目录；非书库提示后重选或取消。
 * 批3 将扩展：非书库目录二次确认 → 引导建书。
 * @returns 校验通过的目录绝对路径；取消返回 null
 */
async function pickLibrary(): Promise<string | null> {
  const parent = mainWindow ?? undefined
  const openOpts: OpenDialogOptions = {
    title: '选择 CLWriting 书库目录',
    properties: ['openDirectory', 'createDirectory'],
  }
  const result = parent
    ? await dialog.showOpenDialog(parent, openOpts)
    : await dialog.showOpenDialog(openOpts)
  const dir = result.canceled ? null : result.filePaths[0]
  if (!dir) return null
  if (isLibraryDir(dir)) return dir
  // 非书库目录 —— 决策②：二次确认是否在此新建书库
  const msgOpts: MessageBoxOptions = {
    type: 'question',
    title: '在此新建书库？',
    message: `「${basename(dir)}」还不是书库目录`,
    detail: '确认后在此新建 CLWriting 书库：重启后书架为空，建第一本书时会自动建立 .clwriting/ 等结构。',
    buttons: ['在此新建', '重新选择', '取消'],
    defaultId: 0,
    cancelId: 2,
  }
  const choice = parent
    ? await dialog.showMessageBox(parent, msgOpts)
    : await dialog.showMessageBox(msgOpts)
  if (choice.response === 0) return dir // 确认在此新建（待建空目录，由调用方持久化 + 重启）
  if (choice.response === 1) return pickLibrary() // 重新选择
  return null // 取消
}

/** 重启进程以应用新 workDir（规避 server 路由单例，见方案 §3.1）。 */
function relaunch(): void {
  app.relaunch()
  // RB-SV-P2-6：走 before-quit 优雅清理（app.exit 会跳过 before-quit）
  app.quit()
}

/** 打开书库（菜单/前端共用）：选 → 存 → 重启。返回是否已触发切换。 */
async function openLibraryAction(): Promise<boolean> {
  const picked = await pickLibrary()
  if (!picked) return false
  saveCurrent(picked)
  relaunch()
  return true
}

// ── 窗口 ──────────────────────────────────────────────

/** 等 server 监听，返回端口。 */
function listenPort(server: ReturnType<typeof startServer>): Promise<number> {
  return new Promise((resolveP, reject) => {
    server.once('listening', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolveP(addr.port)
      else reject(new Error('无法获取监听端口'))
    })
    server.once('error', reject)
  })
}

/** ii 批：安全基线窗口工厂——主窗/书架/书库三处 BrowserWindow 的安全五件套
 *  （contextIsolation + sandbox + nodeIntegration:false + preload + hiddenInset 标题栏）
 *  与纵深防御监听（禁外部导航 + 禁弹新窗）原样重复 3 份，安全配置改一处漏两处是
 *  漂移风险，收敛到此。尺寸/标题/位置由 opts 传入，win 专属生命周期监听由调用方自挂。 */
function createSecureWindow(opts: BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow({
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f5f5',
    ...opts,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(here, 'preload.cjs'),
      ...opts.webPreferences,
    },
  })
  // 纵深防御：禁止导航外部 URL + 禁止弹新窗口（contextIsolation+sandbox 已降险，此为兜底，
  // 防 CSP 被 XSS 绕过后子窗口被导航到外部）
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // dev 模式:不经系统代理（防 clash/surge 类 HTTP 代理 buffer SSE 长连接 → driver events 断流）
  if (process.env.CLW_DEV_UI) {
    void win.webContents.session.setProxy({ proxyRules: 'direct://' })
  }
  return win
}

/** 打开独立书架窗口（工作区时管理/切换/建书；单例，重复调用聚焦已存在窗口）。*/
function openShelfWindow(): void {
  if (shelfWindow && !shelfWindow.isDestroyed()) {
    shelfWindow.focus()
    return
  }
  const wa = screen.getPrimaryDisplay().workAreaSize
  shelfWindow = createSecureWindow({
    width: Math.min(920, wa.width - 80),
    height: Math.min(640, wa.height - 80),
    minWidth: 760,
    minHeight: 500,
    title: '书架',
  })
  shelfWindow.loadURL(`${appUrl}/shelf?win=shelf`)
  shelfWindow.on('closed', () => {
    shelfWindow = null
  })
}

/** 打开独立书库管理窗口（切换/最近/新建书库；单例聚焦）。*/
function openLibraryWindow(): void {
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    libraryWindow.focus()
    return
  }
  const wa = screen.getPrimaryDisplay().workAreaSize
  const libW = Math.min(720, wa.width - 80)
  const libH = Math.min(560, wa.height - 80)
  // 初始位置：居中于主窗口（主窗口 bounds 中心 − 书库半宽/半高）
  let x: number | undefined
  let y: number | undefined
  if (mainWindow && !mainWindow.isDestroyed()) {
    const b = mainWindow.getBounds()
    x = Math.round(b.x + (b.width - libW) / 2)
    y = Math.round(b.y + (b.height - libH) / 2)
  }
  libraryWindow = createSecureWindow({
    width: libW,
    height: libH,
    x,
    y,
    minWidth: 560,
    minHeight: 440,
    title: '书库',
  })
  libraryWindow.loadURL(`${appUrl}/library?win=library`)
  libraryWindow.on('closed', () => {
    libraryWindow = null
  })
}

async function bootstrap(): Promise<void> {
  // 工作目录定位：持久化 current（合法书库 或 决策②待建空目录，目录存在即用）> findWorkDir(cwd)
  // 不再启动时弹原生选择器：无书库 → 主窗口加载 /welcome 起始页引导新建 / 打开。
  const store = readStore()
  let workDir: string | null = null
  if (store.current && existsSync(store.current)) {
    workDir = store.current
  } else {
    workDir = findWorkDir(process.cwd())
  }
  // P5-服务端（第七轮）：记录 bootstrap 实际采用的 workDir——before-quit 原先回读
  // readStore().current，store.current 为 null/失效而 workDir 由 findWorkDir 发现时，
  // 退出拿到 null：不 abort 任何在途 chat/self-heal、不等后台任务（孤儿会话只能靠
  // 10 分钟宽限修复）。退出以启动时实际值优先，store 回读兜底
  bootstrappedWorkDir = workDir
  const needsWelcome = !workDir

  // HMR 开发模式：CLW_DEV_UI=1 时加载 Vite dev server（localhost:5173），前端改动实时热更新；
  // 不起内嵌 server，API 由独立 dev:api(7878) 提供（Vite proxy 转发）。IPC/preload 照常，桌面能力完整。
  const devUi = !!process.env.CLW_DEV_UI
  if (devUi) {
    appUrl = 'http://localhost:5173'
  } else {
    // RB-SV-P2-4：--book 直进接线——argv/env 解析为登记书名，boot 下发前端直达工作区
    //（dev HMR 态不起内嵌 server，boot 由独立 dev-api 提供，此项不生效）
    if (workDir) {
      const ref = initialBookArg(process.argv)
      if (ref) {
        const name = resolveInitialBook(workDir, ref)
        if (name) setInitialBook(name)
      }
    }
    const staticDir = resolveStaticDir()
    const server = startServer({ port: 0, staticDir, workDir, userDataPath: app.getPath('userData'), mirrorConsoleLog: !app.isPackaged })
    studioServer = server // RB-SV-P2-6：退出前 close 用
    const port = await listenPort(server)
    appUrl = `http://127.0.0.1:${port}`
  }

  // 主窗口 bounds：优先恢复上次尺寸/位置，无记录时默认 1532×1237
  // （三栏 + 编辑区留白充足），小屏按工作区 -80px 兜底；min 1200×760 保三栏不挤。
  const saved = loadWinState()
  const wa = screen.getPrimaryDisplay().workAreaSize
  const winW = saved?.bounds.width ?? Math.min(1532, wa.width - 80)
  const winH = saved?.bounds.height ?? Math.min(1237, wa.height - 80)
  mainWindow = createSecureWindow({
    width: winW,
    height: winH,
    x: saved?.bounds.x,
    y: saved?.bounds.y,
    minWidth: 1200,
    minHeight: 760,
    title: 'CLWriting',
  })
  if (saved?.maximized) mainWindow.maximize()
  mainWindow.on('close', () => {
    saveWinState()
  })
  // 书库管理窗口「用完即走」：主窗口获焦 = 用户已切回，关闭书库窗口释放资源
  // （与书架窗口 desktop:open-book 主动 close 行为对齐）
  mainWindow.on('focus', () => {
    if (libraryWindow && !libraryWindow.isDestroyed()) {
      libraryWindow.close()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    // 主窗口是应用核心：关闭即退出（连带销毁书架/书库子窗口，杜绝孤儿窗口 / 僵尸进程）
    app.quit()
  })
  // 捕获 preload 加载错误（sandbox preload 失败时主进程可见，便于排查）
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    log.error('desktop', `preload 加载失败：${p}`, err)
  })
  // dd-P3（C-P3-15）：渲染进程崩溃兜底——GPU/内存崩了不能停在白屏，重载窗口自愈
  const win = mainWindow
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('desktop', `渲染进程崩溃（${details.reason}，exit=${details.exitCode}），重载窗口自愈`)
    if (!win.isDestroyed()) win.webContents.reload()
  })
  // 纵深防御监听与 dev 代理已由 createSecureWindow 统一挂载；此处 await 一次保证
  // 主窗首载前代理确定生效（工厂内是 fire-and-forget，此处 loadURL 前须确定）
  if (devUi) {
    await mainWindow.webContents.session.setProxy({ proxyRules: 'direct://' })
  }
  await mainWindow.loadURL(needsWelcome ? `${appUrl}/welcome` : appUrl)
  // L1（二轮复审）：改走 logger——打包态 mirrorConsole=false，console.log 此前在生产
  // 完全不可见（终端无人看、又不进 JSONL 日志）
  log.info('desktop', `CLWriting ${devUi ? 'dev（HMR）' : '桌面版'}已启动 → ${appUrl}${needsWelcome ? '/welcome' : ''}`)
}

// ── IPC（供 preload 调用）──────────────────────────────

function registerIpc(): void {
  // 弹选择器打开书库
  ipcMain.handle('desktop:open-library', async () => {
    const picked = await pickLibrary()
    if (!picked) return { ok: false as const, canceled: true as const }
    saveCurrent(picked)
    setTimeout(relaunch, 100) // 延迟重启，让响应先回渲染进程
    return { ok: true as const }
  })
  // 切换到最近列表中的书库
  ipcMain.handle('desktop:switch-library', async (_e, path: unknown) => {
    if (typeof path !== 'string' || !isLibraryDir(path)) {
      return { ok: false as const, reason: '目录无效或不是书库' }
    }
    saveCurrent(path)
    setTimeout(relaunch, 100)
    return { ok: true as const }
  })
  ipcMain.handle('desktop:get-recent', () => readStore().recent)
  ipcMain.handle('desktop:get-current', () => readStore().current)
  // 在系统文件管理器中显示文档（electron only；浏览器版前端隐藏此项）
  ipcMain.handle('desktop:show-in-folder', (_e, bookName: unknown, relPath: unknown) => {
    if (typeof bookName !== 'string' || typeof relPath !== 'string') return
    if (relPath.includes('\0')) return
    const workDir = currentWorkDir() // M-3（第八轮）：bootstrap 实际值优先
    if (!workDir) return
    const entry = readBooks(workDir).find((b) => b.name === bookName)
    if (!entry) return
    // 防路径穿越：relPath 必须落在 bookRoot 内（批 6 统一：resolveWithinRoot =
    // resolve/relative 防穿越 + symlink 双侧 realpath 校验，存在时 abs 即 realpath）
    const bookRoot = resolve(workDir, entry.path)
    // 防 books.jsonl 被篡改致 bookRoot 越出 workDir（与 open-book-dir 同口径）
    if (!resolveWithinRoot(workDir, entry.path)) return
    const safe = resolveWithinRoot(bookRoot, relPath)
    if (!safe) return
    // 目标存在才可在文件管理器中显示（abs 已是 realpath，无需再解析）
    if (existsSync(safe.abs)) shell.showItemInFolder(safe.abs)
  })
  // 在系统文件管理器中打开书库根目录（设置弹窗「打开书库目录」入口；浏览器版前端隐藏）
  ipcMain.handle('desktop:open-book-dir', (_e, bookName: unknown) => {
    if (typeof bookName !== 'string' || bookName.includes('\0')) return
    const workDir = currentWorkDir() // M-3（第八轮）：bootstrap 实际值优先
    if (!workDir) return
    const entry = readBooks(workDir).find((b) => b.name === bookName)
    if (!entry) return
    // 路径校验：entry.path 来自 books.jsonl，防 `..`/symlink 越出 workDir 打开任意目录
    // （批 6 统一：resolveWithinRoot = 防穿越 + symlink 双侧 realpath，X-P3a 同口径）
    const safe = resolveWithinRoot(workDir, entry.path)
    if (!safe || !existsSync(safe.abs)) return // realpath 失败/不存在 = 无物可开
    void shell.openPath(safe.abs)
  })
  // 枚举系统已装字体（设置弹窗字体下拉用；font-list 跨平台封装系统命令，disableQuoting 返回裸名便于直拼 CSS）
  ipcMain.handle('desktop:get-system-fonts', async () => {
    try {
      return await getSystemFontList({ disableQuoting: true })
    } catch (e) {
      log.error('desktop', `get-system-fonts 失败：${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  })
  // 打开独立书架窗口（ribbon 书架按钮调用）
  ipcMain.handle('desktop:open-shelf', () => {
    openShelfWindow()
  })
  // 书架窗口选书 → 主窗口加载该书并聚焦，关闭书架窗口
  ipcMain.handle('desktop:open-book', (_e, name: unknown) => {
    if (typeof name !== 'string') return
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:navigate', `/book/${encodeURIComponent(name)}`)
      mainWindow.focus()
    }
    if (shelfWindow && !shelfWindow.isDestroyed()) {
      shelfWindow.close()
    }
  })
  // 打开独立书库管理窗口（ribbon 书库按钮调用）
  ipcMain.handle('desktop:open-library-window', () => {
    openLibraryWindow()
  })
  // 在系统文件管理器中打开当前书库根目录
  ipcMain.handle('desktop:open-library-dir', () => {
    const workDir = currentWorkDir() // M-3（第八轮）：bootstrap 实际值优先
    if (!workDir) return
    // ii 批：与 open-book-dir 同口径——realpath 解析后再开（store.current 持久化值若被
    // 改成指向外部的 symlink/失效路径，不再原样透传给 shell.openPath）
    try {
      void shell.openPath(realpathSync(workDir))
    } catch {
      // realpath 失败 = 目录不存在，无物可开
    }
  })
  // ── 原生右键菜单 ──
  ipcMain.on('desktop:context-menu', (event, specs: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    // RB-SV-P2-5：载荷形状校验前置——非数组/无合法项整体忽略（弹不了菜单但不崩主进程）
    const items = parseContextMenuSpecs(specs)
    if (!items || items.length === 0) return
    let sent = false
    function sendOnce(key: string | null): void {
      if (sent) return
      sent = true
      event.sender.send('desktop:context-menu-select', key)
    }
    function build(s: ContextMenuSpec): MenuItemConstructorOptions {
      if (s.separator) return { type: 'separator' }
      const item: MenuItemConstructorOptions = {
        label: s.label,
        enabled: s.disabled !== true,
        click: () => { sendOnce(s.key ?? null) },
      }
      if (s.accelerator) item.accelerator = s.accelerator
      if (s.submenu && s.submenu.length) item.submenu = s.submenu.map(build)
      return item
    }
    const menu = Menu.buildFromTemplate(items.map(build))
    // popup 非阻塞：菜单关闭走 callback，点选走 click。macOS 下 NSMenu 先关
    // 菜单再派发 action，click 可能晚于 callback —— 故 callback 里延后一拍
    // 才补发 null（取消），给 click 抢先 sendOnce 的机会。渲染侧是
    // ipcRenderer.once，只认第一条消息，抢先发 null 会吞掉整个菜单动作。
    menu.popup({
      window: win,
      callback: () => {
        setTimeout(() => sendOnce(null), 0)
      },
    })
  })
}

// ── 原生菜单 ──────────────────────────────────────────

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  /** 业务菜单项 click → 发 actionKey 给当前聚焦窗口（前端 useAppActions.dispatch 消费）。
   *  actionKey 须与 web-next/src/composables/useAppActions.ts 的 id 一致。 */
  function action(key: string): Pick<MenuItemConstructorOptions, 'click'> {
    return {
      click: () =>
        BrowserWindow.getFocusedWindow()?.webContents.send('desktop:menu-action', key),
    }
  }
  const macAppMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      // macOS 肌肉记忆：偏好设置置于 app 菜单
      { label: '偏好设置…', accelerator: 'CmdOrCtrl+,', ...action('settings') },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建书…', accelerator: 'CmdOrCtrl+N', ...action('new-book') },
        {
          label: '打开书库目录…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void openLibraryAction(),
        },
        { label: '导出…', accelerator: 'CmdOrCtrl+E', ...action('export') },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '切换左栏', accelerator: 'CmdOrCtrl+B', ...action('toggle-left') },
        { label: '切换右栏', accelerator: 'CmdOrCtrl+Shift+B', ...action('toggle-right') },
        { label: '专注模式', accelerator: 'CmdOrCtrl+Shift+F', ...action('focus') },
        { type: 'separator' },
        { label: '切换亮/暗主题', ...action('theme') },
        { type: 'separator' },
        // reload 系仅 dev 保留（V-P1-2）：生产下误触整页重载会丢未保存编辑，兜底保存不保证全救回
        ...(app.isPackaged ? [] : [{ role: 'reload' as const }, { role: 'forceReload' as const }]),
        // 开发者工具仅 dev 显示（打包后隐藏）
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        // 书架/书库管理直接主进程开窗（不绕前端 dispatch）
        { label: '书架', click: () => openShelfWindow() },
        { label: '书库管理', click: () => openLibraryWindow() },
      ],
    },
    // macOS 的「关于」在 app 菜单；非 mac 单独「帮助」菜单承载
    ...(isMac
      ? []
      : [
          {
            label: '帮助',
            submenu: [{ role: 'about' as const }],
          } as MenuItemConstructorOptions,
        ]),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── 生命周期 ──────────────────────────────────────────

// Z-P2-8：单实例锁守卫——第二实例已在顶部 app.quit()，跳过全部生命周期注册，
// 防退出竞态中 whenReady/activate 仍触发 bootstrap（起 server/开窗/读写状态文件）
if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    // 生产模式注入 CSP（开发 HMR 模式跳过——Vite 依赖 unsafe-eval/unsafe-inline）
    if (!process.env.CLW_DEV_UI) {
      session.defaultSession.webRequest.onHeadersReceived((_d, cb) => {
        cb({
          responseHeaders: {
            ..._d.responseHeaders,
            'Content-Security-Policy': [CLW_CSP],
          },
        })
      })
    }
    registerIpc()
    buildMenu()
    runBootstrap((e) => {
      log.error('desktop', `启动失败：${e instanceof Error ? e.message : String(e)}`, e)
      app.quit()
    })
  }).catch((e) => {
    // P5-服务端（第七轮）：whenReady 回调同步段抛错原先变 unhandledRejection，绕过
    // runBootstrap 的错误通道（app 挂无窗口态）——链尾兜底走同一出路
    log.error('desktop', `whenReady 回调失败：${e instanceof Error ? e.message : String(e)}`, e)
    app.quit()
  })

  // Y-P2-7：bootstrap 并发重入防护——macOS 启动慢时点 dock 图标，activate 只判
  // mainWindow === null 会并发二次 bootstrap（双主窗口 + 双内嵌 server）；
  // 只挡「进行中」，完成/失败后仍可重试（保 activate 重建窗口语义）
  // 留账（第十轮 M-6）：Electron main 无测试基建，runBootstrap 重试链路暂无回归测试
  let bootstrapping = false
  function runBootstrap(onError?: (e: unknown) => void): void {
    if (bootstrapping) return
    // 第九轮 L-3：上次 bootstrap 若在 startServer 之后失败（如 loadURL 抛错），重试会再起
    // 新 server 覆盖变量，旧 server 的端口/SSE 计数滞留至进程退出——重试前先关旧的
    if (mainWindow === null && studioServer !== null) {
      studioServer.close()
      studioServer = null
    }
    bootstrapping = true
    void bootstrap()
      .catch((e) => onError?.(e))
      .finally(() => {
        bootstrapping = false
      })
  }

  // 桌面应用：关窗即退出（停 server）
  app.on('window-all-closed', () => {
    app.quit()
  })

  // RB-SV-P2-6：优雅退出——先中断在途编排（self-heal/chat）+ close HTTP server，
  // 再真正退出；总超时 2s 兜底（清理卡死也强制退出）。清理只跑一次，二次 quit 直通。
  let shutdownStarted = false
  app.on('before-quit', (e) => {
    if (shutdownStarted) return
    shutdownStarted = true
    e.preventDefault()
    void Promise.race([
      shutdownStudio(() => bootstrappedWorkDir ?? readStore().current, studioServer),
      new Promise<void>((r) => setTimeout(r, 2_000)),
    ]).finally(() => {
      app.quit()
    })
  })

  app.on('activate', () => {
    // 低-8（第十轮）：退出途中不再重 bootstrap——before-quit 的 2s 优雅退出窗口内
    // （shutdownStarted 已置位）macOS dock 点击仍会触发 activate，若只判
    // mainWindow === null 会在退出半途再起 server/开窗（与 Z-P2-8 退出竞态同族）
    if (shutdownStarted) return
    if (mainWindow === null) {
      runBootstrap((e) => log.error('desktop', '重启失败', e))
    }
  })
}
