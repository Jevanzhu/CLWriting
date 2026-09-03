/**
 * 发布 smoke（U-P2-24）：验证编译产物（tsup dist/desktop + dist/web）能起服务、
 * 前端可加载、核心 API 链路通——Electron 壳 bundle 存在性一并断言。
 *
 * 与常规 e2e 的区别：常规 e2e 直跑 TS 源码（src/studio/server），本 spec 启动的是
 * **编译后的** dist/desktop/server-main.js（与 Electron main 内嵌同一 server 模块），
 * 静态托管 dist/web 构建产物。无 GUI 环境可跑（不启动 Electron）。
 *
 * 跑：npm run test:e2e:release（build:all → tsup + web 构建 → 本 spec）。
 * 常规 npm run test:e2e 跳过（CLWRITING_E2E_RELEASE 未设），不拖慢日常回归。
 */
import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeDualTrackWorkdir } from '../studio/fixtures.js'
import { e2ePort } from './e2e-ports.js'

// 独立端口（基址+16，旧硬编码 19015）——auto-write（基址+3）与本项目分端口并行不抢占
// （R63-15 修正陈旧注释：勿再合并）；R73-75（批 F-8）：改基址派生，偏移表见 e2e-ports.ts
const PORT = e2ePort(16)
const BASE = `http://127.0.0.1:${PORT}`

test.skip(!process.env['CLWRITING_E2E_RELEASE'], '发布 smoke：用 npm run test:e2e:release 跑')

// R74-24（批E）：pageerror/console error 基线（page-error-baseline.ts）本 spec 不接——
// 两个用例均无浏览器 page（纯文件系统断言 + fetch 直连编译产物 server），无渲染层可监听

let child: ChildProcess | undefined
let smokeWorkDir = ''

test.afterAll(async () => {
  // R39-21（三十九轮）：kill 后等退出再删 workDir——Windows 上 kill 是异步收尾，
  // 立刻 rmSync 时 server-main 可能仍持有书库内 SQLite/文件句柄（EBUSY/EPERM 偶发，
  // force 只豁免 ENOENT）；对齐 global-setup 先 close 再删的既有口径。7s 兜底防
  // 子进程僵死拖挂 afterAll（与 graceful-shutdown 总超时同量级）。
  if (child && child.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child?.kill('SIGKILL')
        resolve()
      }, 7_000)
      child!.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      child!.kill('SIGTERM')
    })
  }
  if (smokeWorkDir) rmSync(smokeWorkDir, { recursive: true, force: true })
})

test('编译产物齐备（Electron 壳 bundle + server 入口 + web 静态）', () => {
  expect(existsSync(join('dist', 'desktop', 'main.js'))).toBe(true)
  expect(existsSync(join('dist', 'desktop', 'preload.cjs'))).toBe(true)
  expect(existsSync(join('dist', 'desktop', 'server-main.js'))).toBe(true)
  expect(existsSync(join('dist', 'web', 'index.html'))).toBe(true)
  // R65-57（F-1）：子进程入口件不在 server-main bundle 内联，缺件只在运行期 fork 时炸
  // （utilityProcess/worker_threads）——tsup 入口漏配时本 smoke 此前仍绿。静态断言兜住
  expect(existsSync(join('dist', 'desktop', 'server-utility.js'))).toBe(true)
  expect(existsSync(join('dist', 'desktop', 'export-worker.js'))).toBe(true)
})

test('编译产物 server 起服务：boot/书架/静态前端全链路', async () => {
  smokeWorkDir = makeDualTrackWorkdir()
  child = spawn(process.execPath, [join('dist', 'desktop', 'server-main.js'), '--dir', smokeWorkDir, '--port', String(PORT)], {
    env: { ...process.env, CLWRITING_DRIVER: 'mock' },
    stdio: 'pipe',
  })
  let stderr = ''
  child.stderr?.on('data', (d) => {
    stderr += String(d)
  })

  // 轮询等编译产物 server 起来（进程冷启动 + 书库迁移，给足 15s）
  let boot: Response | undefined
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      boot = await fetch(`${BASE}/api/boot`)
      if (boot.ok) break
    } catch {
      // 未监听，继续轮询
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  expect(boot?.ok, `编译产物 server 未就绪。stderr: ${stderr}`).toBe(true)

  const bootJson = (await boot!.json()) as { token: string }
  expect(bootJson.token).toBeTruthy()

  // 书架 API（双轨 fixture：至少一本书）——T2-3：GET 读端点要求 token（boot 已取得）
  const booksRes = await fetch(`${BASE}/api/books`, {
    headers: { 'x-studio-token': bootJson.token },
  })
  expect(booksRes.ok).toBe(true)
  const books = (await booksRes.json()) as { books: { name: string }[]; workDir: boolean }
  expect(books.workDir).toBe(true)
  expect(books.books.length).toBeGreaterThan(0)

  // 静态前端（dist/web）可加载
  const indexRes = await fetch(`${BASE}/`)
  expect(indexRes.ok).toBe(true)
  const html = await indexRes.text()
  expect(html).toContain('<div id="app"')
})
