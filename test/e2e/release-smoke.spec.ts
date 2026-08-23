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

const PORT = 19002
const BASE = `http://127.0.0.1:${PORT}`

test.skip(!process.env['CLWRITING_E2E_RELEASE'], '发布 smoke：用 npm run test:e2e:release 跑')

let child: ChildProcess | undefined
let smokeWorkDir = ''

test.afterAll(() => {
  if (child && child.exitCode === null) child.kill('SIGTERM')
  if (smokeWorkDir) rmSync(smokeWorkDir, { recursive: true, force: true })
})

test('编译产物齐备（Electron 壳 bundle + server 入口 + web 静态）', () => {
  expect(existsSync(join('dist', 'desktop', 'main.js'))).toBe(true)
  expect(existsSync(join('dist', 'desktop', 'preload.cjs'))).toBe(true)
  expect(existsSync(join('dist', 'desktop', 'server-main.js'))).toBe(true)
  expect(existsSync(join('dist', 'web', 'index.html'))).toBe(true)
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
