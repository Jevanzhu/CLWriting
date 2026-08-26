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
import {
  consumeStreamTicket,
  __setStreamTicketForTest,
} from '../../src/studio/server/api/stream-ticket.js'

const BOOK = '凭据测试书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

/** 打 SSE 端点，返回状态码（不等 body 流，头到手即断） */
function openStream(query: string): Promise<number> {
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
        const status = res.statusCode ?? 0
        res.destroy() // SSE 长连接不消费，头到手即断
        resolve(status)
      },
    )
    r.on('error', () => resolve(0)) // 服务端 destroy 有时先关连接——已拿不到头按 0 计
    r.end()
  })
}

/** 带 token 头的 POST（与前端 fetchStreamTicket 同形：无 body） */
function postTicket(withToken: boolean): Promise<{ status: number; json: { ticket?: string; expiresInMs?: number } }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const headers: Record<string, string> = { origin: baseUrl }
    if (withToken) headers['x-studio-token'] = token
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

  it('过期 ticket → 403；未知/空 ticket → false（consumeStreamTicket 单元口径）', async () => {
    expect(consumeStreamTicket(undefined)).toBe(false)
    expect(consumeStreamTicket('not-a-ticket')).toBe(false)
    const expired = 'expired-ticket'
    __setStreamTicketForTest(expired, Date.now() - 1)
    expect(consumeStreamTicket(expired)).toBe(false)
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
