/**
 * R-8（第十六轮）回归：静态分支 async handler 兜底 catch。
 *
 * index.ts 的静态托管分支此前 `return serveStatic(req, res)` 裸调（无 catch）——
 * serveStatic 是 async（返回 promise），对已销毁连接 writeHead 抛
 * ERR_STREAM_ALREADY_FINISHED 等异步异常变 unhandledRejection（Node ≥15 默认
 * throw 即进程崩溃）。修复：对齐 /api 分支口径包 try/catch——响应未结束则
 * 500 'IO' 信封收尾；已结束则只吞异常不重复写头。R33-58：错误码统一 'IO'（循 R31-26 单一口径）。
 *
 * 注入方式：vi.mock static.ts 的 createStaticHandler 为受控桩（按场景抛错/先收尾再抛）。
 */
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

const mode = { throw: 'sync' as 'sync' | 'after-end' | 'none' }

vi.mock('../../src/studio/server/static.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/studio/server/static.js')>()
  return {
    ...orig,
    createStaticHandler: (rootDir: string) => {
      const real = orig.createStaticHandler(rootDir)
      return async (req: Parameters<typeof real>[0], res: Parameters<typeof real>[1]) => {
        if (mode.throw === 'none') return real(req, res)
        if (mode.throw === 'after-end') {
          // 场景 B：响应已结束（如对已销毁连接的收尾完成后）再抛——修复口径：不重复写头
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('done')
          throw new Error('ERR_STREAM_ALREADY_FINISHED（模拟）：响应结束后异常'
          )
        }
        // 场景 A：handler 内部首步即抛（模拟 writeHead 对已销毁连接抛 ERR_STREAM_ALREADY_FINISHED）
        throw new Error('ERR_STREAM_ALREADY_FINISHED（模拟）：未写任何响应即异常')
      }
    },
  }
})

let root = ''
let server: import('node:http').Server | undefined
let baseUrl = ''
let unhandled: unknown[] = []

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-static-catch-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Studio</title>')
  server = await startServerSafe({ port: 0, workDir: root, staticDir: root })
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  unhandled = []
  process.on('unhandledRejection', recordUnhandled)
})

function recordUnhandled(e: unknown): void {
  unhandled.push(e)
}

afterAll(async () => {
  process.off('unhandledRejection', recordUnhandled)
  if (server) {
    // R46-12（四十六轮）：GET 改 createReadStream 后 res finish 比客户端收完 body 晚
    // 一拍——紧随 fetch 调 close() 时连接仍在「在途」态（close 只收割调用时已空闲的
    // 连接），会等满 startServer 的 keepAliveTimeout 30s 才回调（>10s hookTimeout 假红；
    // 生产同型面由 server-main.ts SIGINT 链的 2s exitNow 兜底覆盖）。收尾补一刀
    // closeAllConnections（测试用例均已 await fetch，无在途请求可误伤）。
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('R-8: 静态分支 serveStatic 异常兜底', () => {
  it('A：serveStatic 抛错且响应未结束 → 500 IO 信封，且无 unhandledRejection', async () => {
    mode.throw = 'sync'
    const r = await fetch(`${baseUrl}/index.html`)
    expect(r.status).toBe(500)
    expect(JSON.parse(await r.text())).toEqual({ code: 'IO', error: '服务器内部错误' })
    await new Promise((resolveP) => setTimeout(resolveP, 100))
    expect(unhandled).toHaveLength(0) // 修复前：promise 未捕获 → unhandledRejection
  })

  it('B：响应已结束后抛错 → 不重复写头不崩，原响应完整，无 unhandledRejection', async () => {
    mode.throw = 'after-end'
    const r = await fetch(`${baseUrl}/index.html`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('done')
    await new Promise((resolveP) => setTimeout(resolveP, 100))
    expect(unhandled).toHaveLength(0)
  })

  it('C：正常路径不受影响（兜底不误伤）', async () => {
    mode.throw = 'none'
    const r = await fetch(`${baseUrl}/index.html`)
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('<title>Studio</title>')
  })
})
