/**
 * R61-E-1 回归：鉴权闸拒绝路径的请求体排空钩子（与自订口径一致）。
 *
 * 原状：排空钩子只挂在 /api 分支（R64-28）、/API/ 404 分支与 static.ts 405 分支
 * （R65-47）——入口六处闸拒绝路径（bad request 400 / Host 403 / OPTIONS 204 /
 * 写 Origin 403 / 写 token 403 / GET token 403）漏挂：被拒请求的 body 无人保证
 * 排空，keep-alive 连接的复用与否取决于运行时（Node ≥25 核心在响应 finish 后
 * 自动排空——本机 node 26 实测裸 server 亦可复用；而 Electron 内嵌 Node / CI
 * node 24 等无该自动化的运行时上即 R64-28 同型失守：body 滞留 → 同 socket 下一
 * 请求不被解析 → 连接整条弃掉）。口径要求所有请求路径一律排空。
 * 修法：排空钩子上提 createServer 请求回调最顶部统一单挂点（先于任何
 * replyError/return，对所有请求生效），分支内重复挂点删除。
 *
 * 两层断言：
 * 1. 机制（修复前红）：经公共 prototype.on/once 统计每请求挂载的 'finish' 钩子，
 *    按注册栈过滤出应用层挂载（'studio/server/index.ts|static.ts'）——Node 核心
 *    的 parserOnIncoming 也会给每个响应经公共 .on 挂一个内部 finish 钩子
 *   （node:_http_server），必须按栈过滤才量得到应用层；本机（node 26）实测修复前
 *    闸拒绝路径应用层计 0（红）、/api 分支计 1（对照组，钩子在 index.ts /api 分支）。
 *    修复后入口单挂点全路径 ≥1（绿）。
 * 2. 行为（守住无自动排空的运行时）：跟随 api-keepalive-drain.test.ts（R64-28）
 *    手法——keep-alive Agent（maxSockets 1）被拒请求后同 socket 第二请求正常
 *    往返。注：node ≥25 核心在响应 finish 后自动排空未消费 body（本机实测），
 *    该层修复前后皆绿，作为 Electron 内嵌 Node / CI node 24 等运行时的防回归
 *    护栏保留。
 */
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

const BOOK = '闸拒排空书'
let workDir = ''
let server: http.Server | undefined
let port = 0

// ── 机制探针：统计 ServerResponse 经公共 .on/.once 注册的 'finish' 监听数，
//    按注册栈过滤出应用层（排除 Node 核心 parserOnIncoming 的内部钩子）──
let appFinishHooks = 0
const origOn = http.ServerResponse.prototype.on
const origOnce = http.ServerResponse.prototype.once

function countAppFinishHook(): void {
  // win 宿主 Error.stack 文件帧路径是反斜杠（本机 node 26 实测），正斜杠子串恒
  // 匹配不上 → 应用层钩子恒计 0。先归一为正斜杠再 includes；mac/linux 栈本就
  // 正斜杠，replace 恒等，跨平台无害。
  const stack = (new Error().stack ?? '').replace(/\\/g, '/')
  if (stack.includes('studio/server/index.ts') || stack.includes('studio/server/static.ts')) appFinishHooks++
}

beforeAll(async () => {
  http.ServerResponse.prototype.on = function (ev: string | symbol, listener: (...args: any[]) => void) {
    if (ev === 'finish') countAppFinishHook()
    return origOn.call(this, ev, listener)
  }
  http.ServerResponse.prototype.once = function (ev: string | symbol, listener: (...args: any[]) => void) {
    if (ev === 'finish') countAppFinishHook()
    return origOnce.call(this, ev, listener)
  }

  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r61e1-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  mkdirSync(join(workDir, BOOK, '项目'), { recursive: true })
  writeFileSync(join(workDir, BOOK, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 闸拒排空书\nhost: cc\n', 'utf8')
  server = await startServerSafe({ port: 0, workDir })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  http.ServerResponse.prototype.on = origOn
  http.ServerResponse.prototype.once = origOnce
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/** 5s 守卫：无自动排空的运行时上第二请求会悬挂，用可读错误快速失败 */
function orHang<T>(p: Promise<T>, msg: string): Promise<T> {
  let t: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(msg)), 5000)
  })
  t?.unref()
  return Promise.race([p, guard]).finally(() => clearTimeout(t))
}

/** 同一 keep-alive agent 上的单次请求；记录用到的 socket 以断言复用 */
function requestOn(
  agent: http.Agent,
  sockets: Set<net.Socket>,
  opts: { method: string; path: string; headers?: Record<string, string> },
  body?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers }
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
    const r = http.request(
      { host: '127.0.0.1', port, method: opts.method, path: opts.path, headers, agent },
      (res) => {
        res.resume() // 消费响应体（keep-alive 复用的另一半前提）
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    r.on('socket', (s) => sockets.add(s))
    r.on('error', reject)
    r.end(body)
  })
}

const BODY = JSON.stringify({ padding: 'x'.repeat(512) })
/** headers 值占位符：运行时替换为本实例 listening 后的白名单 Origin */
const ALLOWED = ':allowed'

interface GateCase {
  title: string
  method: string
  path: string
  headers?: Record<string, string>
  expectStatus: number
}

/** 闸拒绝场景表（全部带 body）：覆盖入口六处拒绝路径中经 http 客户端可构造的五处 */
const GATE_CASES: GateCase[] = [
  { title: '写 Origin 403', method: 'POST', path: '/api/books/x/rename', headers: { origin: 'http://evil.example' }, expectStatus: 403 },
  { title: '写 token 403', method: 'POST', path: '/api/books/x/rename', headers: { origin: ALLOWED, 'x-studio-token': 'wrong-token' }, expectStatus: 403 },
  { title: 'GET token 403', method: 'GET', path: '/api/books', expectStatus: 403 },
  { title: 'Host 403', method: 'POST', path: '/api/books/x/rename', headers: { host: 'evil.example:1' }, expectStatus: 403 },
  { title: 'OPTIONS 204', method: 'OPTIONS', path: '/api/books/x/rename', headers: { origin: ALLOWED }, expectStatus: 204 },
]

describe('R61-E-1：闸拒绝路径带 body → 排空钩子挂载 + keep-alive 连接可复用', () => {
  /** headers 占位符解析（listening 后白名单才含本实例 Origin） */
  function resolveHeaders(c: GateCase): Record<string, string> {
    return Object.fromEntries(
      Object.entries(c.headers ?? {}).map(([k, v]) => [k, v === ALLOWED ? `http://127.0.0.1:${port}` : v]),
    )
  }

  for (const c of GATE_CASES) {
    it(`${c.method} ${c.path}（${c.title}）→ ${c.expectStatus}，且请求挂了排空钩子、同 socket 第二请求正常往返`, async () => {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
      const sockets = new Set<net.Socket>()
      try {
        appFinishHooks = 0
        const s1 = await requestOn(agent, sockets, { method: c.method, path: c.path, headers: resolveHeaders(c) }, BODY)
        expect(s1).toBe(c.expectStatus)
        // 红：修复前闸拒绝路径不挂排空钩子（对照 /api 分支挂 1——下方控制用例）
        expect(appFinishHooks).toBeGreaterThanOrEqual(1)

        // 行为护栏：同 socket 第二请求正常往返（无自动排空的运行时上修复前悬挂）
        const s2 = await orHang(
          requestOn(agent, sockets, { method: 'GET', path: '/api/boot' }),
          `第二个请求悬挂：${c.title} 路径被拒后请求体未排空（R61-E-1）`,
        )
        expect(s2).toBe(200)
        expect(sockets.size).toBe(1) // 同一 socket 承载两次请求
      } finally {
        agent.destroy()
      }
    })
  }

  it('控制组：/api 分支本就挂排空钩子（探针有效性对照）', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    const sockets = new Set<net.Socket>()
    try {
      appFinishHooks = 0
      const s = await requestOn(agent, sockets, { method: 'GET', path: '/api/boot' })
      expect(s).toBe(200)
      expect(appFinishHooks).toBeGreaterThanOrEqual(1)
    } finally {
      agent.destroy()
    }
  })

  // bad request 400（absolute-form 请求行）：http.request 客户端不便构造该形态，
  // 用 raw socket 写两个请求验证（手法对齐 static.test.ts Q-1 用例）
  it('bad request 400（absolute-form 请求行）带 body → 排空钩子挂载 + 同 socket 第二请求正常往返', async () => {
    const first =
      `POST http://evil.example/api/books/x/rename HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(BODY)}\r\n` +
      `\r\n` +
      BODY
    const second = `GET /api/boot HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`

    /** 从缓冲中摘出一个完整响应（content-length / chunked 双定界）；不够则返回 null */
    const takeResponse = (buf: string): { head: string; rest: string } | null => {
      const headEnd = buf.indexOf('\r\n\r\n')
      if (headEnd < 0) return null
      const head = buf.slice(0, headEnd)
      const bodyAt = headEnd + 4
      const cl = /content-length:\s*(\d+)/i.exec(head)
      if (cl) {
        const end = bodyAt + Number(cl[1])
        return buf.length >= end ? { head, rest: buf.slice(end) } : null
      }
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        let pos = bodyAt
        for (;;) {
          const sizeEnd = buf.indexOf('\r\n', pos)
          if (sizeEnd < 0) return null
          const size = Number.parseInt(buf.slice(pos, sizeEnd).trim(), 16)
          if (!Number.isFinite(size)) return null
          if (size === 0) {
            const tailEnd = buf.indexOf('\r\n', sizeEnd + 2) // 终止块后的收尾 CRLF
            if (tailEnd < 0) return null
            return { head: buf.slice(0, tailEnd + 2), rest: buf.slice(tailEnd + 2) }
          }
          pos = sizeEnd + 2 + size + 2 // 块数据 + 块尾 CRLF
          if (buf.length < pos) return null
        }
      }
      return null
    }
    const statusOf = (head: string): number => Number(/^HTTP\/1\.\d (\d{3})/.exec(head)?.[1] ?? 0)

    appFinishHooks = 0
    let hooksAfterFirst = -1
    const result = await orHang(
      new Promise<{ s1: number; s2: number }>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1')
        let buf = ''
        let s1 = 0
        const done = (err?: unknown, s2?: number): void => {
          sock.removeAllListeners()
          sock.destroy()
          if (err) reject(err instanceof Error ? err : new Error(String(err)))
          else resolve({ s1, s2: s2! })
        }
        const timer = setTimeout(() => done(new Error('raw socket 5s 内未完成两次往返：请求体未排空（R61-E-1）')), 5000)
        timer.unref()
        const clearTimer = (): void => clearTimeout(timer)
        sock.on('close', clearTimer)
        sock.on('error', (e) => done(e))
        sock.on('connect', () => sock.write(first))
        sock.on('data', (d) => {
          buf += d.toString('latin1')
          for (;;) {
            const t = takeResponse(buf)
            if (!t) return
            if (s1 === 0) {
              s1 = statusOf(t.head)
              buf = t.rest
              expect(s1).toBe(400) // absolute-form 请求行 → 入口 400（X-20）
              // 第一跳响应当时的钩子数（第二跳 /api/boot 会自己挂钩子，不能混入）
              hooksAfterFirst = appFinishHooks
              sock.write(second)
              continue
            }
            clearTimer()
            done(undefined, statusOf(t.head))
            return
          }
        })
      }),
      'raw socket 往返悬挂：bad request 400 后请求体未排空（R61-E-1）',
    )
    expect(result.s1).toBe(400)
    expect(result.s2).toBe(200) // 同一 socket 上第二个请求正常往返
    // 红：修复前 bad request 400 路径不挂排空钩子
    expect(hooksAfterFirst).toBeGreaterThanOrEqual(1)
  })
})
