/**
 * stream-ticket 端点集成测试（T2 批：SSE 凭据信道收敛）。
 *
 * 覆盖：POST /api/stream-ticket 签发（写闸）→ SSE `?ticket=` 过闸（一次性消费）→
 * 复用同 ticket 403 → `?token=` 旧通道兼容仍放行 → 过期 ticket 403。
 * SSE 建流只验到「过凭据闸拿到 200 event-stream」，不驱动生成（底层单测兜底）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { createStreamTicketStore, type StreamTicketStore } from '../../src/studio/server/api/stream-ticket.js'

const BOOK = '凭据测试书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

/** R73-49：取 startServer 挂到 server 对象上的本实例票库 */
function ticketsOf(s: http.Server): StreamTicketStore {
  return (s as http.Server & { __streamTickets?: StreamTicketStore }).__streamTickets!
}

/** 打 SSE 端点，返回状态码（不等 body 流，头到手即断）；base 可指定实例（R73-49 多实例用） */
function openStreamOn(base: string, query: string): Promise<number> {
  return new Promise((resolve) => {
    const u = new URL(base)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `/api/books/${encodeURIComponent(BOOK)}/stream${query}`,
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      },
      (res) => {
        const status = res.statusCode ?? 0
        res.destroy() // SSE 长连接不消费，头到手即断
        resolve(status)
      },
    )
    r.on('error', () => resolve(0)) // 服务端 destroy 有时先关连接——已拿不到头按 0 计
    r.end()
  })
}

function openStream(query: string): Promise<number> {
  return openStreamOn(baseUrl, query)
}

/** 带 token 头的 POST（与前端 fetchStreamTicket 同形：无 body）；base/token 可指定实例 */
function postTicketOn(base: string, tok: string, withToken: boolean): Promise<{ status: number; json: { ticket?: string; expiresInMs?: number } }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base)
    const headers: Record<string, string> = { origin: base }
    if (withToken) headers['x-studio-token'] = tok
    const r = http.request(
      { host: u.hostname, port: u.port, path: '/api/stream-ticket', method: 'POST', headers },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: { ticket?: string; expiresInMs?: number } = {}
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 留空 */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    r.end()
  })
}

function postTicket(withToken: boolean): Promise<{ status: number; json: { ticket?: string; expiresInMs?: number } }> {
  return postTicketOn(baseUrl, token, withToken)
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-stream-ticket-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-ticket-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '定稿', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 凭据测试书\n  genre: 玄幻\nhost: cc\n',
  )
  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  rmSync(workDir, { recursive: true, force: true })
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('stream-ticket 端点', () => {
  it('POST 带 token → 200 签发一次性 ticket（TTL 显式回传）', async () => {
    const r = await postTicket(true)
    expect(r.status).toBe(200)
    expect(typeof r.json.ticket).toBe('string')
    expect(r.json.expiresInMs).toBe(60_000)
  })

  it('POST 无 token → 403（写闸拦截，不签发）', async () => {
    const r = await postTicket(false)
    expect(r.status).toBe(403)
  })

  it('SSE ?ticket= 有效 → 200 过闸；同 ticket 复用 → 403（一次性）', async () => {
    const r = await postTicket(true)
    expect(r.status).toBe(200)
    const t = r.json.ticket!
    expect(await openStream(`?ticket=${encodeURIComponent(t)}`)).toBe(200)
    expect(await openStream(`?ticket=${encodeURIComponent(t)}`)).toBe(403)
  })

  it('SSE ?token= 旧通道兼容仍放行（e2e/兼容期）', async () => {
    expect(await openStream(`?token=${encodeURIComponent(token)}`)).toBe(200)
  })

  it('过期 ticket → 403；未知/空 ticket → false（consume 单元口径，注入本实例票库）', async () => {
    const tickets = ticketsOf(server!)
    expect(tickets.consume(undefined)).toBe(false)
    expect(tickets.consume('not-a-ticket')).toBe(false)
    const expired = 'expired-ticket'
    tickets.__setForTest(expired, Date.now() - 1)
    expect(tickets.consume(expired)).toBe(false)
    expect(await openStream(`?ticket=${encodeURIComponent(expired)}`)).toBe(403)
  })
})

describe('R64-27（十二轮）：SSE 鉴权前移——403 与书名存在性无关', () => {
  it('无凭据：登记书与未登记书同回 403（原 resolveBook 先行 404 可差异探测书名）', async () => {
    expect(await openStream('')).toBe(403) // 登记在册书
    // 未登记书：修复前 resolveBook 先回 404，与 403 形成存在性信道
    const u = new URL(baseUrl)
    const status = await new Promise<number>((resolve) => {
      const r = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: `/api/books/${encodeURIComponent('不存在的书')}/stream`,
          method: 'GET',
          headers: { accept: 'text/event-stream' },
        },
        (res) => {
          const st = res.statusCode ?? 0
          res.destroy()
          resolve(st)
        },
      )
      r.on('error', () => resolve(0))
      r.end()
    })
    expect(status).toBe(403)
  })
})

// R65-43（总六十五轮）：ticket 消费移到全部书域校验（429 连接数 / resolveBook 404）
// 之后——原闸首即烧票，429/404 时一次性 ticket 被白白作废，EventSource 自动重连带
// 废票反复 403。鉴权顺序语义不变（R64-27 防探测：无凭据仍先 403）。
describe('R65-43：429/404 不烧一次性 ticket（消费在书域校验之后）', () => {
  /** 保持打开的 SSE 连接（占连接配额）；返回关闭句柄（收尾必须关——server.close 等） */
  function openStreamHold(query: string): Promise<() => void> {
    return new Promise((resolve) => {
      const u = new URL(baseUrl)
      const r = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: `/api/books/${encodeURIComponent(BOOK)}/stream${query}`,
          method: 'GET',
          headers: { accept: 'text/event-stream' },
        },
        (res) => {
          res.on('data', () => {}) // 挂后台消费，防背压缓冲（连接活着即可）
          resolve(() => r.destroy())
        },
      )
      r.on('error', () => {})
      r.end()
    })
  }

  it('连接数满 429 → ticket 未被消费；腾出名额后同票可用', async () => {
    const closers: Array<() => void> = []
    try {
      // 占满 5 条（MAX_SSE_PER_BOOK，凭据走 token 旧通道——与被测 ticket 无关）
      for (let i = 0; i < 5; i++) closers.push(await openStreamHold(`?token=${encodeURIComponent(token)}`))
      await new Promise((r) => setTimeout(r, 100)) // 等服务端登记句柄
      const t = (await postTicket(true)).json.ticket!
      // 第 6 条：429（BUSY）——修复前此步已把 ticket 烧掉
      expect(await openStream(`?ticket=${encodeURIComponent(t)}`)).toBe(429)
      // ticket 未被消费：腾一条名额后同票仍可建流（修复前 → 403）
      closers[0]!()
      await new Promise((r) => setTimeout(r, 100))
      expect(await openStream(`?ticket=${encodeURIComponent(t)}`)).toBe(200)
    } finally {
      for (const c of closers) c()
    }
  })

  it('未登记书 404 → ticket 未被消费；同票对登记书仍可用', async () => {
    const t = (await postTicket(true)).json.ticket!
    const u = new URL(baseUrl)
    const status404 = await new Promise<number>((resolve) => {
      const r = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: `/api/books/${encodeURIComponent('不存在的书')}/stream?ticket=${encodeURIComponent(t)}`,
          method: 'GET',
          headers: { accept: 'text/event-stream' },
        },
        (res) => {
          const st = res.statusCode ?? 0
          res.destroy()
          resolve(st)
        },
      )
      r.on('error', () => resolve(0))
      r.end()
    })
    expect(status404).toBe(404) // 凭据过闸（peek）→ 书域校验 404
    // ticket 未被 404 烧掉：对登记书同票 → 200（修复前 → 403）
    expect(await openStream(`?ticket=${encodeURIComponent(t)}`)).toBe(200)
  })
})

// R73-49（二十一轮）：票库 per-server 实例化——原模块级单例在同进程二次 startServer
// 时旧实例的未过期票残留可消费。回归锚定：旧实例签发的票在新实例凭据闸 403（peek
// 不到即拒，若残留/共享会放行到 200）、新实例票库快照无旧票、新实例签发/一次性语义
// 照常。单元面（工厂隔离）+ 集成面（同进程二次 startServer）双层。
describe('R33D-6：SSE x-studio-token 头通道全链可建流', () => {
  it('header-only（无 ?ticket=/?token=）→ 预检放行且建流 200（消费点补认 header）；无凭据仍 403', async () => {
    // 消费点此前只认 ?token=/?ticket=：header-only 请求过预检+书域校验后建流前必 403
    const u = new URL(baseUrl)
    const status = await new Promise<number>((resolve) => {
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: `/api/books/${encodeURIComponent(BOOK)}/stream`,
          method: 'GET',
          headers: { accept: 'text/event-stream', 'x-studio-token': token },
        },
        (res) => {
          const st = res.statusCode ?? 0
          res.destroy()
          resolve(st)
        },
      )
      req.on('error', () => resolve(0))
      req.end()
    })
    expect(status).toBe(200)
    // 对照：完全无凭据仍 403（预检闸未松动）
    const status403 = await new Promise<number>((resolve) => {
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: `/api/books/${encodeURIComponent(BOOK)}/stream`,
          method: 'GET',
          headers: { accept: 'text/event-stream' },
        },
        (res) => {
          const st = res.statusCode ?? 0
          res.destroy()
          resolve(st)
        },
      )
      req.on('error', () => resolve(0))
      req.end()
    })
    expect(status403).toBe(403)
  })
})

describe('R73-49：票库随 server 实例隔离', () => {
  it('工厂级：两个票库互不相通（库 A 签发的票在库 B peek/consume 均 false）', () => {
    const a = createStreamTicketStore()
    const b = createStreamTicketStore()
    const t = a.issue().ticket
    expect(a.peek(t)).toBe(true)
    expect(b.peek(t)).toBe(false)
    expect(b.consume(t)).toBe(false)
    expect(a.consume(t)).toBe(true) // 一次性语义在本库内不受影响
  })

  it('同进程二次 startServer：旧实例票在新实例不可用且零残留，新实例签发照常', async () => {
    // 旧实例（beforeAll 起）签发一张票，保持未消费
    const oldTicket = (await postTicket(true)).json.ticket!
    expect(oldTicket).toBeTruthy()
    await new Promise<void>((r) => server!.close(() => r()))

    const serverB = startServer({ port: 0, workDir, userDataPath })
    await new Promise<void>((r) => serverB.once('listening', r))
    const baseB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`
    const rBoot = await fetch(`${baseB}/api/boot`)
    const tokenB = ((await rBoot.json()) as { token: string }).token
    try {
      // 旧票：新实例凭据闸 403（未过期票若残留/共享，此处会放行进书域 → 200）
      expect(await openStreamOn(baseB, `?ticket=${encodeURIComponent(oldTicket)}`)).toBe(403)
      // 零残留：新实例票库快照不含旧票
      const storeB = ticketsOf(serverB)
      expect(storeB.__entries().has(oldTicket)).toBe(false)
      // 新实例签发/一次性语义照常：新票首连 200、复用 403
      const t2 = (await postTicketOn(baseB, tokenB, true)).json.ticket!
      expect(t2).toBeTruthy()
      expect(await openStreamOn(baseB, `?ticket=${encodeURIComponent(t2!)}`)).toBe(200)
      expect(await openStreamOn(baseB, `?ticket=${encodeURIComponent(t2!)}`)).toBe(403)
    } finally {
      await new Promise<void>((r) => serverB.close(() => r()))
    }
  })
})

describe('R32-21：在库票上限（签发频控，内存有界）', () => {
  it('连发 300 票 → 在库恒 ≤256；最早签发的超容票被逐出（peek/consume false），新票有效', () => {
    const store = createStreamTicketStore()
    const issued: string[] = []
    for (let i = 0; i < 300; i++) issued.push(store.issue().ticket)
    // 上限钉板：300 连发后库存恰为 256（修复前无界涨到 300）
    expect(store.__entries().size).toBe(256)
    // 300 - 256 = 44 张最早签发的票被逐出
    for (const t of issued.slice(0, 44)) {
      expect(store.peek(t)).toBe(false)
      expect(store.consume(t)).toBe(false)
    }
    // 留存票照常有效（一次性语义不受上限影响）
    expect(store.peek(issued[44]!)).toBe(true)
    expect(store.peek(issued[299]!)).toBe(true)
    expect(store.consume(issued[299]!)).toBe(true)
    expect(store.__entries().size).toBe(255)
  })
})
