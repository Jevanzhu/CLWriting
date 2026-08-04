/**
 * Electron 主进程入口（桌面化 #electron）。
 *
 * 起 studio server（复用 src/studio/server，127.0.0.1 随机端口）→ BrowserWindow loadURL。
 * 前端 Vue 零改造（fetch /api/...）；driver 复用（spawn claude）。
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
} from 'electron'
import { join, dirname, resolve, relative, isAbsolute, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { startServer } from '../studio/server/index.js'
import { findWorkDir, readBooks } from '../install/books.js'
import { atomicWriteFile } from '../fs/atomic.js'
import { defaultUserDataPath } from '../fs/user-data-path.js'
import { getFonts as getSystemFontList } from 'font-list'
import {
  parseStore,
  setCurrent,
  filterValidRecent,
  serializeStore,
  emptyStore,
} from './workdir-store.js'
import type { WorkDirStore } from './workdir-store.js'

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
  app.exit(0)
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

/** 打开独立书架窗口（工作区时管理/切换/建书；单例，重复调用聚焦已存在窗口）。*/
function openShelfWindow(): void {
  if (shelfWindow && !shelfWindow.isDestroyed()) {
    shelfWindow.focus()
    return
  }
  const wa = screen.getPrimaryDisplay().workAreaSize
  shelfWindow = new BrowserWindow({
    width: Math.min(920, wa.width - 80),
    height: Math.min(640, wa.height - 80),
    minWidth: 760,
    minHeight: 500,
    title: '书架',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f5f5',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(here, 'preload.cjs'),
    },
  })
  shelfWindow.loadURL(`${appUrl}/shelf?win=shelf`)
  shelfWindow.on('closed', () => {
    shelfWindow = null
  })
  if (process.env.CLW_DEV_UI) {
    void shelfWindow.webContents.session.setProxy({ proxyRules: 'direct://' })
  }
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
  libraryWindow = new BrowserWindow({
    width: libW,
    height: libH,
    x,
    y,
    minWidth: 560,
    minHeight: 440,
    title: '书库',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f5f5',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(here, 'preload.cjs'),
    },
  })
  libraryWindow.loadURL(`${appUrl}/library?win=library`)
  libraryWindow.on('closed', () => {
    libraryWindow = null
  })
  if (process.env.CLW_DEV_UI) {
    void libraryWindow.webContents.session.setProxy({ proxyRules: 'direct://' })
  }
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
  const needsWelcome = !workDir

  // HMR 开发模式：CLW_DEV_UI=1 时加载 Vite dev server（localhost:5173），前端改动实时热更新；
  // 不起内嵌 server，API 由独立 dev:api(7878) 提供（Vite proxy 转发）。IPC/preload 照常，桌面能力完整。
  const devUi = !!process.env.CLW_DEV_UI
  if (devUi) {
    appUrl = 'http://localhost:5173'
  } else {
    const staticDir = resolveStaticDir()
    const server = startServer({ port: 0, staticDir, workDir, userDataPath: app.getPath('userData') })
    const port = await listenPort(server)
    appUrl = `http://127.0.0.1:${port}`
  }

  // 主窗口 bounds：优先恢复上次尺寸/位置，无记录时默认 1532×1237
  // （三栏 + 编辑区留白充足），小屏按工作区 -80px 兜底；min 1200×760 保三栏不挤。
  const saved = loadWinState()
  const wa = screen.getPrimaryDisplay().workAreaSize
  const winW = saved?.bounds.width ?? Math.min(1532, wa.width - 80)
  const winH = saved?.bounds.height ?? Math.min(1237, wa.height - 80)
  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: saved?.bounds.x,
    y: saved?.bounds.y,
    minWidth: 1200,
    minHeight: 760,
    title: 'CLWriting',
    // macOS 自定义标题栏：隐藏原生标题文字+按钮，保留交通灯（inset 缩进）；Vue 画 .window-chrome（书信息+CLI 徽章）
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f5f5', // paper 底色（亮色主题基底）
    webPreferences: {
      contextIsolation: true, // 渲染进程隔离（安全）
      sandbox: true, // 沙箱（安全）
      nodeIntegration: false, // 渲染进程不直连 Node（安全）
      preload: join(here, 'preload.cjs'), // 书库管理 IPC（CJS:sandbox preload 不支持 ESM）
    },
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
    console.error('PRELOAD-ERROR', p, err.message)
  })
  // 纵深防御：禁止页面导航外部 URL + 禁止弹新窗口（contextIsolation+sandbox 已降险，此为兜底）
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // dev 模式:本地 dev:web(5173)+dev:api(7878) 不经系统代理
  // 防 clash/surge 类 HTTP 代理 buffer SSE 长连接 → driver events 断流 / EventSource 反复重连
  if (devUi) {
    await mainWindow.webContents.session.setProxy({ proxyRules: 'direct://' })
  }
  await mainWindow.loadURL(needsWelcome ? `${appUrl}/welcome` : appUrl)
  console.log(`✓ CLWriting ${devUi ? 'dev（HMR）' : '桌面版'}已启动 → ${appUrl}${needsWelcome ? '/welcome' : ''}`)
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
    const workDir = readStore().current
    if (!workDir) return
    const entry = readBooks(workDir).find((b) => b.name === bookName)
    if (!entry) return
    // 防路径穿越：relPath 必须落在 bookRoot 内（复刻 DocumentService.resolveSafePath 内含校验）
    const bookRoot = resolve(workDir, entry.path)
    // 防 books.jsonl 被篡改致 bookRoot 越出 workDir（与 open-book-dir 同口径）
    if (relative(workDir, bookRoot).startsWith('..')) return
    const absPath = resolve(bookRoot, relPath)
    const rel = relative(bookRoot, absPath)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
    if (existsSync(absPath)) shell.showItemInFolder(absPath)
  })
  // 在系统文件管理器中打开书库根目录（设置弹窗「打开书库目录」入口；浏览器版前端隐藏）
  ipcMain.handle('desktop:open-book-dir', (_e, bookName: unknown) => {
    if (typeof bookName !== 'string') return
    const workDir = readStore().current
    if (!workDir) return
    const entry = readBooks(workDir).find((b) => b.name === bookName)
    if (!entry) return
    // 路径校验：entry.path 来自 books.jsonl，防 `..` 越出 workDir 打开任意目录
    const target = resolve(workDir, entry.path)
    if (relative(workDir, target).startsWith('..')) return
    void shell.openPath(target)
  })
  // 枚举系统已装字体（设置弹窗字体下拉用；font-list 跨平台封装系统命令，disableQuoting 返回裸名便于直拼 CSS）
  ipcMain.handle('desktop:get-system-fonts', async () => {
    try {
      return await getSystemFontList({ disableQuoting: true })
    } catch (e) {
      console.error('get-system-fonts 失败：', e instanceof Error ? e.message : String(e))
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
    const workDir = readStore().current
    if (workDir) void shell.openPath(workDir)
  })
  // ── 原生右键菜单 ──
  ipcMain.on('desktop:context-menu', (event, specs: unknown[]) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    let sent = false
    function sendOnce(key: string | null): void {
      if (sent) return
      sent = true
      event.sender.send('desktop:context-menu-select', key)
    }
    function build(s: Record<string, unknown>): MenuItemConstructorOptions {
      if (s.separator) return { type: 'separator' }
      const item: MenuItemConstructorOptions = {
        label: (s.label as string) ?? '',
        enabled: s.disabled !== true,
        click: () => { sendOnce(s.key as string) },
      }
      if (s.accelerator) item.accelerator = s.accelerator as string
      const sub = s.submenu
      if (Array.isArray(sub) && sub.length) item.submenu = (sub as Record<string, unknown>[]).map(build)
      return item
    }
    const menu = Menu.buildFromTemplate(specs.map((s) => build(s as Record<string, unknown>)))
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
        { role: 'reload' },
        { role: 'forceReload' },
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
  bootstrap().catch((e) => {
    console.error('✗ 启动失败：', e instanceof Error ? e.message : String(e))
    app.quit()
  })
})

// 桌面应用：关窗即退出（停 server）
app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) {
    bootstrap().catch((e) => console.error('✗ 重启失败：', e))
  }
})
