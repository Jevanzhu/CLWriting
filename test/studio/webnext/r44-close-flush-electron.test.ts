/**
 * R44-2（四十四轮）实机回归：关窗兜底 = 主进程 close 拦截 + executeJavaScript 异步
 * flush——不 stub 任何 XHR/fetch，用仓库自带 Electron 真引擎 + 本地 HTTP 真网络验证。
 *
 * 背景（四十四轮报告 §3.1）：f3 系测试 vi.stubGlobal('XMLHttpRequest') 对真实引擎
 * 行为结构性失明——V-P1-2 的 beforeunload 内同步 XHR 兜底经双 Electron 实验证实
 * 在 Chromium ≥M80 卸载路径零字节到达。本测试把「拦截 close → 页面存活期异步
 * fetch 落盘 → destroy 直关」这条生产链原样缩样到 fixture，堵住引擎级盲区：
 * 修复形态若退回卸载窗口内发请求（或拦截丢失），PUT 不会到达，本测试即红。
 *
 * 平台守卫：win32/darwin 本机可跑（GUI 会话）；linux 无 DISPLAY（headless CI 腿）跳过。
 */
import { test, expect, describe } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'

const require = createRequire(import.meta.url)

/** electron npm 包入口导出二进制路径字符串（win: electron.exe / mac: Electron 二进制）。 */
function electronBinary(): string {
  return require('electron') as unknown as string
}

const canRunRealElectron =
  process.platform === 'win32' || process.platform === 'darwin' || Boolean(process.env.DISPLAY)

describe.skipIf(!canRunRealElectron)('R44-2 实机: close 拦截 + 异步 flush 落盘（真引擎零 stub）', () => {
  test('beforeunload 窗口外的异步 fetch 在拦截 close 下送达，destroy 前服务端收到 PUT', { timeout: 60_000 }, async () => {
    // 本地 HTTP：页面 + PUT /save 收集面（同源 fetch，无 CORS 变量）
    const puts: string[] = []
    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/page') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          // 页面模拟 Book 页钩子（生产形态见 stores/doc.ts flushBeforeClose +
          // pages/Book.vue 注册）：异步 fetch，不在 beforeunload 里发任何请求
          res.end(`<!doctype html><html><body><script>
            window.__DIRTY__ = 'DIRTY-CONTENT-r44-marker'
            window.__clwFlushBeforeClose = async () => {
              await fetch('/save', { method: 'PUT', body: window.__DIRTY__ })
              return { failed: [], conflict: [] }
            }
          </script></body></html>`)
          return
        }
        if (req.method === 'PUT' && req.url === '/save') {
          const chunks: Buffer[] = []
          req.on('data', (c) => chunks.push(c as Buffer))
          req.on('end', () => {
            puts.push(Buffer.concat(chunks).toString('utf8'))
            res.writeHead(204)
            res.end()
          })
          return
        }
        res.writeHead(404)
        res.end()
      })
      s.listen(0, '127.0.0.1', () => resolve(s))
    })
    const port = (server.address() as { port: number }).port

    // fixture：复刻 src/desktop/main.ts 的 close 拦截链（preventDefault →
    // executeJavaScript flush → destroy），驱动后自行退出
    const dir = await mkdtemp(join(tmpdir(), 'r44-close-flush-'))
    const fixture = join(dir, 'main.js')
    await writeFile(
      fixture,
      `const { app, BrowserWindow } = require('electron')
const base = process.argv[process.argv.length - 1]
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false })
  let closing = false
  win.on('close', (e) => {
    if (closing) return
    e.preventDefault()
    closing = true
    ;(async () => {
      try {
        await Promise.race([
          win.webContents.executeJavaScript(
            'typeof window.__clwFlushBeforeClose === "function" ? window.__clwFlushBeforeClose() : Promise.resolve(null)',
          ),
          new Promise((r) => setTimeout(r, 4000)),
        ])
      } catch {}
      if (!win.isDestroyed()) win.destroy()
      app.exit(0)
    })()
  })
  win.loadURL(base + '/page').then(() => setTimeout(() => win.close(), 300))
})
`,
      'utf8',
    )

    let child: ChildProcess | undefined
    try {
      child = spawn(electronBinary(), [fixture, `http://127.0.0.1:${port}`], {
        stdio: 'ignore',
        windowsHide: true,
      })
      const exitCode = await new Promise<number | null>((resolve) => {
        child!.once('exit', (code) => resolve(code))
        // 兜底：30s 未退（fixture 挂死形态）杀掉按失败处理
        setTimeout(() => {
          if (child?.exitCode === null) child?.kill()
          resolve(-1)
        }, 30_000)
      })
      expect(exitCode, 'fixture 应正常退出（exit 0）').toBe(0)
      // 修复锚点：拦截窗口内异步 fetch 真实送达（修复前的同步 XHR 形态此处为空）
      expect(puts).toEqual(['DIRTY-CONTENT-r44-marker'])
    } finally {
      child?.kill()
      await rm(dir, { recursive: true, force: true })
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
