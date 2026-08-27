import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createStaticHandler } from '../../src/studio/server/static.js'

// M-P3-09（内存核查 2026-08-25）：透传式 spy——只计数不改行为，断言 HEAD 分支不再 readFile 整读
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
const readFileMock = vi.mocked(readFile)

let root = ''
let server: http.Server | undefined
let baseUrl = ''

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-studio-static-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Studio</title>')
  server = http.createServer(createStaticHandler(root))
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

test('static handler rejects malformed uri without killing server', async () => {
  const bad = await fetch(`${baseUrl}/%E0%A4%A`)
  expect(bad.status).toBe(400)
  // hh §八-12：静态层错误也走统一 JSON 信封 {code, error}
  expect(JSON.parse(await bad.text())).toEqual({ code: 'BAD_INPUT', error: 'bad request' })

  const ok = await fetch(`${baseUrl}/`)
  expect(ok.status).toBe(200)
  expect(await ok.text()).toContain('<title>Studio</title>')
})

// Q-1（第十五轮）：absolute-form 畸形请求行——new URL 构造抛错路径。此前 static handler
// 首语句裸调 new URL，async 回调 rejection 无兜底（/api 分支有 catch、静态分支没有）→
// unhandledRejection（Node ≥15 默认 throw = 进程崩溃，至少请求挂死）。
// 下方用例标题「rejects malformed uri」只覆盖 decodeURIComponent 守卫，未覆盖本路径。
test('Q-1: 畸形 absolute-form 请求行（new URL 抛错路径）→ 400 信封且服务存活', async () => {
  const address = server!.address() as AddressInfo
  const raw = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(address.port, '127.0.0.1')
    const timer = setTimeout(() => reject(new Error('2s 内无响应（疑似 handler 抛错未回应）')), 2_000)
    sock.on('connect', () => {
      sock.write(`GET http://[bad HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`)
    })
    sock.on('data', (d) => {
      clearTimeout(timer)
      resolve(d.toString('latin1'))
      sock.destroy()
    })
    sock.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  expect(raw.startsWith('HTTP/1.1 400')).toBe(true)

  // 对照：服务仍存活（修复前该请求把 handler 打挂，后续请求不受影响才是目标）
  const ok = await fetch(`${baseUrl}/`)
  expect(ok.status).toBe(200)
  expect(await ok.text()).toContain('<title>Studio</title>')
})

test('cache-control: assets 下内容 hash 产物 immutable，其余 no-cache（Y-P2-7）', async () => {
  mkdirSync(join(root, 'assets'), { recursive: true })
  // 文件名带内容 hash 是 vite 产物惯例，判定只看路径在 assets/ 下
  writeFileSync(join(root, 'assets', 'index-B1rKx3Q2.js'), 'console.log(1)')
  writeFileSync(join(root, 'favicon.ico'), 'ico')

  // vite 构建产物（assets/ 下）→ 一年 immutable 长缓存
  const asset = await fetch(`${baseUrl}/assets/index-B1rKx3Q2.js`)
  expect(asset.status).toBe(200)
  expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

  // SPA 入口（index.html）→ no-cache，保证发版后立即生效
  const html = await fetch(`${baseUrl}/`)
  expect(html.status).toBe(200)
  expect(html.headers.get('cache-control')).toBe('no-cache')

  // 非 assets 静态文件 → no-cache
  const ico = await fetch(`${baseUrl}/favicon.ico`)
  expect(ico.status).toBe(200)
  expect(ico.headers.get('cache-control')).toBe('no-cache')

  // SPA fallback（不存在的路由回 index.html）→ no-cache
  const spa = await fetch(`${baseUrl}/some/deep/route`)
  expect(spa.status).toBe(200)
  expect(spa.headers.get('cache-control')).toBe('no-cache')
})

// X-21（第五十六轮）：缓存判定用规范化后路径——原用未规范化的 decodedPathname，
// `/assets/../index.html` 字面前缀命中 /assets/ 但 normalize 后实发 SPA 入口，
// 修复前错拿一年 immutable 长缓存（发版变更被钉死）。fetch/undici 发送前会把 URL
// 的 dot segments 归一化，构造字面 `..` 请求行必须走 raw socket。
test('X-21: /assets/../index.html → 实发 SPA 入口 no-cache（穿越字面不拿 immutable）', async () => {
  const address = server!.address() as AddressInfo
  const raw = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(address.port, '127.0.0.1')
    const timer = setTimeout(() => reject(new Error('2s 内无响应')), 2_000)
    sock.on('connect', () => {
      sock.write(`GET /assets/../index.html HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: close\r\n\r\n`)
    })
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
    })
    sock.on('end', () => {
      clearTimeout(timer)
      resolve(buf)
    })
    sock.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  expect(raw.startsWith('HTTP/1.1 200')).toBe(true)
  expect(raw).toContain('<title>Studio</title>') // 实发 SPA 入口（穿越落回根）
  // 头部段只取 CRLF 分隔行——body 里的内容不参与 startsWith 断言
  const headerLines = raw.slice(0, raw.indexOf('\r\n\r\n'))
  expect(headerLines).toContain('cache-control: no-cache') // 修复前：immutable
  expect(headerLines).not.toContain('immutable')
})

// M-9（第十一轮）：canonical 双侧 realpath 判界——dist 被植入外指 symlink 不得读出
// Windows 无 POSIX 权限位/需开发者模式，symlinkSync 直建 EPERM，该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('M-9: dist 内 symlink 外指 root 外文件 → 403（canonical 判界，非前缀判界）', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'clwriting-static-out-'))
  try {
    writeFileSync(join(outside, 'secret.txt'), 'secret-content-should-not-leak')
    // 字面前缀合法（dist 内）、stat 跟随 symlink 到 root 外——旧字符串前缀判界放行
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'))

    const res = await fetch(`${baseUrl}/leak.txt`)
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(JSON.parse(body)).toEqual({ code: 'BAD_PATH', error: 'forbidden' })
    expect(body).not.toContain('secret')
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

// Windows 无 POSIX 权限位/需开发者模式，symlinkSync 直建 EPERM，该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('M-9: root 内部 symlink（合法用途）仍正常服务', async () => {
  writeFileSync(join(root, 'real.js'), 'console.log("ok")')
  symlinkSync(join(root, 'real.js'), join(root, 'alias.js'))

  const res = await fetch(`${baseUrl}/alias.js`)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('console.log("ok")')
})

// N-3（第十二轮）：errno 分流——存在文件读失败（EACCES 等 IO 错误）不再混叠成 SPA 200
// Windows 无 POSIX 权限位（chmod 为 no-op/仅映射只读位），该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('N-3: 存在的文件读失败（EACCES）→ 500 IO_ERROR；不存在路由仍 SPA fallback 200', async () => {
  writeFileSync(join(root, 'blocked.js'), 'console.log(1)')
  chmodSync(join(root, 'blocked.js'), 0o000) // stat 过、readFile 拒——模拟权限/IO 故障

  const res = await fetch(`${baseUrl}/blocked.js`)
  expect(res.status).toBe(500)
  const body = await res.text()
  expect(JSON.parse(body)).toEqual({ code: 'IO_ERROR', error: expect.stringContaining('EACCES') })
  expect(body).not.toContain('<title>Studio</title>') // 修复前：静默换成 SPA 入口 200

  // 对照：ENOENT 语义不变——不存在的路由仍回 index.html
  const spa = await fetch(`${baseUrl}/no/such/route`)
  expect(spa.status).toBe(200)
  expect(await spa.text()).toContain('<title>Studio</title>')
})

// B-21（第六十轮）：HEAD 响应补 content-length 且不发 body——此前与 GET 同分支
// res.end(data)：整文件读入内存后才丢弃、响应缺 RFC 9110 期望元数据
test('B-21: HEAD 带 content-length 且无 body（命中文件与 SPA fallback 两路）；GET 行为不变', async () => {
  writeFileSync(join(root, 'app.js'), 'console.log(1)')
  const head = await fetch(`${baseUrl}/app.js`, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(Number(head.headers.get('content-length'))).toBe('console.log(1)'.length)
  expect(await head.text()).toBe('')
  // GET 同路径不受影响
  const get = await fetch(`${baseUrl}/app.js`)
  expect(await get.text()).toBe('console.log(1)')

  // SPA fallback 的 HEAD 同口径：长度与 GET fallback 一致、无 body
  const spaHead = await fetch(`${baseUrl}/missing-route`, { method: 'HEAD' })
  const spaGet = await fetch(`${baseUrl}/missing-route`)
  expect(spaHead.status).toBe(200)
  expect(spaHead.headers.get('content-length')).toBe(spaGet.headers.get('content-length'))
  expect(await spaHead.text()).toBe('')
  expect((await spaGet.text()).length).toBe(Number(spaHead.headers.get('content-length')))
})

// M-P3-09（内存核查 2026-08-25）：HEAD 跳过 readFile 整读——修复前 HEAD 与 GET 同分支
// readFile(safe.abs)，整文件读入内存仅为取 data.length 作 content-length（body 本就不发送）。
// 现尺寸直接取 stat（文件分支 s.size；目录→index.html 分支补 stat），readFile 调用次数为 0。
test('M-P3-09: HEAD 不整读文件（readFile 0 次）且 content-length=字节数、body 空；GET 行为不变', async () => {
  writeFileSync(join(root, 'app.js'), 'console.log(1)')

  readFileMock.mockClear()
  const head = await fetch(`${baseUrl}/app.js`, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(readFileMock).not.toHaveBeenCalled() // 修复前：整读仅为取 data.length
  expect(Number(head.headers.get('content-length'))).toBe(Buffer.byteLength('console.log(1)'))
  expect(await head.text()).toBe('')

  // 目录 → index.html 分支：s 为目录 stat（size 无意义）→ 对最终文件补 stat 取尺寸，同样不整读
  const dirHead = await fetch(`${baseUrl}/`, { method: 'HEAD' })
  expect(dirHead.status).toBe(200)
  expect(readFileMock).not.toHaveBeenCalled()
  expect(Number(dirHead.headers.get('content-length'))).toBe(Buffer.byteLength('<!doctype html><title>Studio</title>'))

  // GET 行为不变：照常 readFile 整读发 body
  readFileMock.mockClear()
  const get = await fetch(`${baseUrl}/app.js`)
  expect(readFileMock).toHaveBeenCalledTimes(1)
  expect(await get.text()).toBe('console.log(1)')
})

// R65-47（总六十五轮）：405 分支 finish 后排空未消费请求体——写方法（POST/PUT）打到
// 非 /api 路径时 handler 不读 body 也不 resume，keep-alive 连接因 body 滞留被弃；
// 排空后同 socket 可承载下一请求（与 index.ts /api 分支 R64-28 同口径）。
test('R65-47: 405 后请求体被排空——keep-alive 连接可复用', async () => {
  const address = server!.address() as AddressInfo
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  const sockets = new Set<net.Socket>()
  const post = (payload: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/',
          method: 'POST',
          agent,
          headers: { 'content-length': String(Buffer.byteLength(payload)) },
        },
        (res) => {
          res.resume() // 消费响应体（keep-alive 复用的另一半前提）
          res.on('end', () => resolve(res.statusCode ?? 0))
        },
      )
      r.on('socket', (s) => sockets.add(s))
      r.on('error', reject)
      r.end(payload)
    })
  try {
    const s1 = await post('x'.repeat(512))
    expect(s1).toBe(405)
    // 修复前：第一个请求的 body 未排空，第二个请求在同 socket 上不被解析（悬挂）
    const s2 = await Promise.race([
      post('y'.repeat(512)),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('第二个请求悬挂：请求体未排空')), 5000)),
    ])
    expect(s2).toBe(405)
    expect(sockets.size).toBe(1) // 同一 socket 承载两次请求
  } finally {
    agent.destroy()
  }
})
