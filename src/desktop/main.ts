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
  ipcMain,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type MessageBoxOptions,
} from 'electron'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { startServer } from '../studio/server/index.js'
import { findWorkDir } from '../install/books.js'
import { atomicWriteFile } from '../fs/atomic.js'
import {
  parseStore,
  setCurrent,
  filterValidRecent,
  serializeStore,
  emptyStore,
} from './workdir-store.js'
import type { WorkDirStore } from './workdir-store.js'

const here = dirname(fileURLToPath(import.meta.url)) // dist/desktop/

/** 前端静态目录：打包后 asar 内 / 开发项目根 dist/web */
function resolveStaticDir(): string {
  return app.isPackaged
    ? join(app.getAppPath(), 'dist', 'web') // 打包：app.asar/dist/web
    : resolve(here, '..', '..', 'dist', 'web') // 开发：here=dist/desktop/ → 项目根/dist/web
}

let mainWindow: BrowserWindow | null = null

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

async function bootstrap(): Promise<void> {
  // 工作目录定位：持久化 current（合法书库 或 决策②待建空目录，目录存在即用）> findWorkDir(cwd) > 弹选择器
  const store = readStore()
  let workDir: string | null = null
  if (store.current && existsSync(store.current)) {
    workDir = store.current
  } else {
    workDir = findWorkDir(process.cwd())
    if (!workDir) {
      // 无持久化（或失效）、cwd 也没定位到 → 弹选择器
      const picked = await pickLibrary()
      if (picked) {
        saveCurrent(picked)
        workDir = picked
      }
    }
  }

  if (!workDir) {
    console.warn('⚠ 未定位到工作目录，书架将为空（请在书架页点「打开书库」选择）。')
  }

  // HMR 开发模式：CLW_DEV_UI=1 时加载 Vite dev server（localhost:5173），前端改动实时热更新；
  // 不起内嵌 server，API 由独立 dev:api(7878) 提供（Vite proxy 转发）。IPC/preload 照常，桌面能力完整。
  const devUi = !!process.env.CLW_DEV_UI
  let url: string
  if (devUi) {
    url = 'http://localhost:5173'
  } else {
    const staticDir = resolveStaticDir()
    const server = startServer({ port: 0, staticDir, workDir })
    const port = await listenPort(server)
    url = `http://127.0.0.1:${port}`
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'CLWriting',
    backgroundColor: '#e8e8e8', // v5 canvas（与 AppShell .clw-desktop 底色一致；无窗口外框后窗口底色直接可见）
    webPreferences: {
      contextIsolation: true, // 渲染进程隔离（安全）
      sandbox: true, // 沙箱（安全）
      nodeIntegration: false, // 渲染进程不直连 Node（安全）
      preload: join(here, 'preload.cjs'), // 书库管理 IPC（CJS:sandbox preload 不支持 ESM）
    },
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // 捕获 preload 加载错误（sandbox preload 失败时主进程可见，便于排查）
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    console.error('PRELOAD-ERROR', p, err.message)
  })
  await mainWindow.loadURL(url)
  console.log(`✓ CLWriting ${devUi ? 'dev（HMR）' : '桌面版'}已启动 → ${url}`)
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
}

// ── 原生菜单 ──────────────────────────────────────────

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const macAppMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
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
        {
          label: '打开书库目录…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void openLibraryAction(),
        },
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
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── 生命周期 ──────────────────────────────────────────

app.whenReady().then(() => {
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
