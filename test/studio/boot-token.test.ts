/**
 * RB-SV-P1-1 回归：/api/boot 的 token 条件回传 + dev Origin 白名单开关。
 *
 * - 外部 Origin 的 boot 拿不到 token（此前免鉴权回传写 token = 全部写权限旁路）
 * - 无 Origin（本机 curl/测试直连）与同源 Origin 拿得到（既有链路语义不变）
 * - 生产态 5173 Origin 不在白名单（boot 无 token；写端点 403）
 * - CLW_DEV_UI=1（dev:web/dev:app 链路）时 5173 Origin 可拿 token
 * - RB-SV-P2-4：setInitialBook 后 boot 回传 initialBook
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { setInitialBook } from '../../src/studio/server/api/books.js'

let workDir = ''
const servers: http.Server[] = []
const baseUrls: string[] = []
const prevDevUi = process.env['CLW_DEV_UI']
const prevDevCors = process.env['CLW_DEV_CORS']

function rawRequest(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = '',
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method, headers },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: Record<string, unknown> = {}
          try {
            json = JSON.parse(data) as Record<string, unknown>
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** 起一个 server（port 0），登记待清理。 */
async function bootServer(opts: { devUi?: boolean; studioToken?: string } = {}): Promise<string> {
  if (opts.devUi) process.env['CLW_DEV_UI'] = '1'
  else delete process.env['CLW_DEV_UI']
  delete process.env['CLW_DEV_CORS']
  const s = startServer({ port: 0, workDir, studioToken: opts.studioToken })
  servers.push(s)
  await new Promise<void>((r) => s.once('listening', r))
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  baseUrls.push(url)
  return url
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-boot-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  mkdirSync(join(workDir, '测试书'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: '测试书', path: '测试书', kind: 'long' }) + '\n')
})

afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (prevDevUi === undefined) delete process.env['CLW_DEV_UI']
  else process.env['CLW_DEV_UI'] = prevDevUi
  if (prevDevCors === undefined) delete process.env['CLW_DEV_CORS']
  else process.env['CLW_DEV_CORS'] = prevDevCors
  setInitialBook(undefined) // 复位模块态，防串到其他用例
})

describe('RB-SV-P1-1 /api/boot token 条件回传', () => {
  it('无 Origin（本机直连 curl/测试）→ 回传 token', async () => {
    const base = await bootServer()
    const r = await rawRequest(base, 'GET', '/api/boot')
    expect(r.status).toBe(200)
    expect(typeof r.json['token']).toBe('string')
    expect((r.json['token'] as string).length).toBeGreaterThan(10)
  })

  it('同源 Origin → 回传 token（生产态 Electron / e2e 链路）', async () => {
    const base = await bootServer()
    const r = await rawRequest(base, 'GET', '/api/boot', { origin: base })
    expect(r.status).toBe(200)
    expect(typeof r.json['token']).toBe('string')
  })

  it('外部 Origin → 200 但不回传 token', async () => {
    const base = await bootServer()
    const r = await rawRequest(base, 'GET', '/api/boot', { origin: 'http://evil.example' })
    expect(r.status).toBe(200)
    expect(r.json['token']).toBeUndefined()
  })

  it('生产态 5173 Origin（本地任意页面可监听的端口）→ 不回传 token + 写端点 403', async () => {
    const base = await bootServer()
    const boot = await rawRequest(base, 'GET', '/api/boot', { origin: 'http://localhost:5173' })
    expect(boot.status).toBe(200)
    expect(boot.json['token']).toBeUndefined()
    const write = await rawRequest(
      base,
      'POST',
      `/api/books/${encodeURIComponent('测试书')}/outline`,
      { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      JSON.stringify({ chapter: 1 }),
    )
    expect(write.status).toBe(403)
  })

  it('CLW_DEV_UI=1（dev:web/dev:app 链路）→ 5173 Origin 可拿 token + 写端点过 Origin 闸', async () => {
    const base = await bootServer({ devUi: true })
    const boot = await rawRequest(base, 'GET', '/api/boot', { origin: 'http://localhost:5173' })
    expect(boot.status).toBe(200)
    expect(typeof boot.json['token']).toBe('string')
    // 过 Origin 闸后进 dispatch（无 token → 403 invalid token，而非 403 forbidden origin）
    const write = await rawRequest(
      base,
      'POST',
      `/api/books/${encodeURIComponent('测试书')}/outline`,
      { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      JSON.stringify({ chapter: 1 }),
    )
    expect(write.status).toBe(403)
    expect(String(write.json['error'])).toContain('token')
  })
})

describe('U-6（阶段 22）：startServer 可选 studioToken 注入（唯一红线豁免——缺省行为不变）', () => {
  it('注入 token → boot 恰回传该 token；写端点 token 闸按注入值校验', async () => {
    const injected = '11111111-2222-4333-8444-555555555555'
    const base = await bootServer({ studioToken: injected })
    const boot = await rawRequest(base, 'GET', '/api/boot')
    expect(boot.json['token']).toBe(injected)
    // 同源 Origin + 错 token → 403 invalid token（闸值即注入值，非内部 randomUUID）
    const wrong = await rawRequest(
      base,
      'POST',
      `/api/books/${encodeURIComponent('测试书')}/outline`,
      { origin: base, 'content-type': 'application/json', 'x-studio-token': 'wrong-token' },
      JSON.stringify({ chapter: 1 }),
    )
    expect(wrong.status).toBe(403)
    expect(String(wrong.json['error'])).toContain('token')
    // 对注入 token 放行：同 token 重写等价口径（错误码差异留给路由层，这里只锁闸语义）
    const right = await rawRequest(
      base,
      'POST',
      `/api/books/${encodeURIComponent('测试书')}/outline`,
      { origin: base, 'content-type': 'application/json', 'x-studio-token': injected },
      JSON.stringify({ chapter: 1 }),
    )
    expect(right.status).not.toBe(403)
  })
})

describe('RB-SV-P2-4 boot 回传 initialBook', () => {
  it('setInitialBook 后 boot 回传 initialBook；外部 Origin 下 initialBook 仍回传但 token 不回', async () => {
    const base = await bootServer()
    setInitialBook('测试书')
    const sameOrigin = await rawRequest(base, 'GET', '/api/boot', { origin: base })
    expect(sameOrigin.json['initialBook']).toBe('测试书')
    expect(typeof sameOrigin.json['token']).toBe('string')
    const foreign = await rawRequest(base, 'GET', '/api/boot', { origin: 'http://evil.example' })
    expect(foreign.json['initialBook']).toBe('测试书')
    expect(foreign.json['token']).toBeUndefined()
    setInitialBook(undefined)
    const reset = await rawRequest(base, 'GET', '/api/boot')
    expect(reset.json['initialBook']).toBeUndefined()
  })
})

describe('R64-30（十二轮）：initialBook 生命周期随 server close 复位（无跨实例残留）', () => {
  it('实例1 set → boot 回传；close 后实例2（未 set）→ boot initialBook 空', async () => {
    const workDir2 = mkdtempSync(join(tmpdir(), 'clwriting-r64-30-'))
    mkdirSync(join(workDir2, '.clwriting'), { recursive: true })
    writeFileSync(
      join(workDir2, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: '书A', path: '书A', kind: 'long' }) + '\n',
    )
    const boot = async (base: string): Promise<{ initialBook?: string }> =>
      ((await (await fetch(`${base}/api/boot`)).json()) as { initialBook?: string })
    try {
      setInitialBook('书A')
      const s1 = startServer({ port: 0, workDir: workDir2 })
      await new Promise<void>((r) => s1.once('listening', r))
      const b1 = await boot(`http://127.0.0.1:${(s1.address() as import('node:net').AddressInfo).port}`)
      expect(b1.initialBook).toBe('书A')
      await new Promise<void>((r) => s1.close(() => r()))

      // 第二次无 --book 启动：close 已复位模块态，不得残留上一实例初始书
      const s2 = startServer({ port: 0, workDir: workDir2 })
      await new Promise<void>((r) => s2.once('listening', r))
      const b2 = await boot(`http://127.0.0.1:${(s2.address() as import('node:net').AddressInfo).port}`)
      expect(b2.initialBook).toBeUndefined()
      await new Promise<void>((r) => s2.close(() => r()))
    } finally {
      rmSync(workDir2, { recursive: true, force: true })
    }
  })
})
