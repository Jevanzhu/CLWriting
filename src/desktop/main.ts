/**
 * Electron 主进程入口（桌面化 #electron）。
 *
 * 起 studio server（复用 src/studio/server，127.0.0.1 随机端口）→ BrowserWindow loadURL。
 * 前端 Vue 零改造（fetch /api/...）；driver 复用（spawn claude）；node:sqlite 已验证可用（Node 24）。
 *
 * 开发：npm run dev:electron（build:web + tsup + electron .）
 * 打包：electron-builder（dist/web + dist/desktop/main.js 进 asar）
 */
import { app, BrowserWindow } from 'electron'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../studio/server/index.js'
import { findWorkDir } from '../install/books.js'

const here = dirname(fileURLToPath(import.meta.url)) // dist/desktop/

/** 前端静态目录：打包后 asar 内 / 开发项目根 dist/web */
function resolveStaticDir(): string {
  return app.isPackaged
    ? join(app.getAppPath(), 'dist', 'web') // 打包：app.asar/dist/web
    : resolve(here, '..', '..', 'dist', 'web') // 开发：here=dist/desktop/ → 项目根/dist/web
}

let mainWindow: BrowserWindow | null = null

async function bootstrap(): Promise<void> {
  const workDir = findWorkDir(process.cwd())
  const staticDir = resolveStaticDir()
  const server = startServer({ port: 0, staticDir, workDir })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('listening', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('无法获取监听端口'))
    })
    server.once('error', reject)
  })

  if (!workDir) {
    console.warn('⚠ 未定位到工作目录（当前目录不含 .clwriting/），书架将为空。')
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'CLWriting',
    backgroundColor: '#f9fafb',
    webPreferences: {
      contextIsolation: true, // 渲染进程隔离（安全）
      sandbox: true, // 沙箱（安全）
      nodeIntegration: false, // 渲染进程不直连 Node（安全）
    },
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  await mainWindow.loadURL(`http://127.0.0.1:${port}`)
  console.log(`✓ CLWriting 桌面版已启动 → http://127.0.0.1:${port}`)
}

app.whenReady().then(() => {
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
