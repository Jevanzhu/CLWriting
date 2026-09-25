/**
 * RC 源码重审 B-3（Opus-5.5 轮）回归：SSE 名额探测不建流、不占名额（服务端面）。
 *
 * 形态（修复前，已在本仓实测复现）：前端 useSse.probeSseBusy 以 GET 探 /stream 取状态码
 * ——服务端 200 路径在响应头之前即登记 connHandle、推 sync 快照、ensureSession（真建流），
 * 客户端 abort 前该名额一直被占。与 fail-closed 首档 0ms 重连并发时探测会抢走最后一个
 * 名额：4 条在途 + GET 探测 → 探测 200（计数 5）→ 紧随的正式流 429 → 再等一档退避 4s
 * ——探测本为「解释断连」，反而制造断连。
 *
 * 修复：新增 HEAD /api/books/:name/stream（books.stream.probe）——与 GET 同路径同闸
 * （三凭据预检 + 名额判定 + 书域 404），只判定不登记：不消费 ticket（只 peek）、不登记
 * connHandle、不推 sync 快照、不 ensureSession。
 *
 * 本文件钉住两件事：
 * 1. 探测不占名额、不漏名额：重复探测后正式流仍可建，MAX_SSE_PER_BOOK 计数零污染；
 * 2. 闸口径与建流逐条同源：满额时探测与建流同状态码（BUSY 信封文案单源），
 *    token/Origin 维度上探测不引入比建流更严/更松的第三态。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { __getSseConnections } from '../../src/studio/server/api/stream.js'
import { MAX_SSE_PER_BOOK } from '../../src/studio/server/api/stream-sse-writer.js'

const BOOK = 'B3探测书'
/** 满额用例专用的另一本书：避免与「空载」用例共享名额账目。 */
const FULL_BOOK = 'B3满额书'

let studio: StudioHarness
const openStreams: AbortController[] = []
/** 在途流响应体挂后台消费（防背压缓冲占满；abort 后抛错忽略） */
const readers: Array<Promise<unknown>> = []

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-rc-b3-',
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: B3探测书\n  genre: 玄幻\nhost: cc\n',
  })
  // 补登记第二本书（bootStudio 只写单条 books.jsonl）
  const reg = join(studio.workDir, '.clwriting', 'books.jsonl')
  writeFileSync(reg, readFileSync(reg, 'utf8') + JSON.stringify({ name: FULL_BOOK, path: FULL_BOOK, kind: 'long' }) + '\n')
  mkdirSync(join(studio.workDir, FULL_BOOK), { recursive: true })
  writeFileSync(
    join(studio.workDir, FULL_BOOK, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: B3满额书\n  genre: 玄幻\nhost: cc\n',
  )
})

afterAll(async () => {
  for (const ac of openStreams) ac.abort()
  await studio.close()
})

/** 等计数/连接重建稳定（服务端 req close → 账目移除是事件循环一拍）。 */
async function tick(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

function streamPath(name: string, query = ''): string {
  return `/api/books/${encodeURIComponent(name)}/stream${query}`
}

/** 名额探测（B-3 后的形：HEAD，只判定不建流）→ 状态码。 */
async function probe(name: string, headers: Record<string, string> = {}): Promise<number> {
  const r = await fetch(`${studio.baseUrl}${streamPath(name)}`, {
    method: 'HEAD',
    headers: { 'x-studio-token': studio.token, ...headers },
  })
  return r.status
}

/** 正式建流（GET，EventSource 等价物）→ 状态码。 */
async function openStream(name: string, headers: Record<string, string> = {}, query = ''): Promise<number> {
  const ac = new AbortController()
  openStreams.push(ac)
  const r = await fetch(`${studio.baseUrl}${streamPath(name, query)}`, {
    headers: { 'x-studio-token': studio.token, ...headers },
    signal: ac.signal,
  })
  readers.push(r.body?.getReader().read().catch(() => undefined) ?? Promise.resolve())
  return r.status
}

/** 关掉最近一条在途流并等账目回落。 */
async function closeLastStream(): Promise<void> {
  openStreams[openStreams.length - 1]!.abort()
  await tick()
}

/** 裸 http 状态码（可设任意 Origin，不经 fetch 的头部处置）：GET 读到响应头即断流。 */
function rawStatus(method: 'HEAD' | 'GET', path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(studio.baseUrl)
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      resolve(res.statusCode ?? 0)
      if (method === 'GET') req.destroy() // SSE 长连接不回 body end：拿到状态码即断
      else res.resume()
    })
    req.on('error', () => reject(new Error('raw request error')))
    req.end()
  })
}

describe('RC 源码重审 B-3: 探测不建流、不占名额', () => {
  it('空载：HEAD 探测 → 200（可建流判定）且不登记连接账目；连探后正式流仍可建（计数零污染）', async () => {
    expect(__getSseConnections().has(BOOK)).toBe(false)
    for (let i = 0; i < 3; i++) expect(await probe(BOOK)).toBe(200)
    await tick()
    // 关键断言：探测不产生任何连接账目（修复前 GET 探测在此已计 1，abort 后才回落）
    expect(__getSseConnections().has(BOOK)).toBe(false)
    // 探测若干次后正式流照常建立（探测未泄漏名额）
    expect(await openStream(BOOK)).toBe(200)
    await tick()
    expect(__getSseConnections().get(BOOK)).toBe(1)
    await closeLastStream()
    expect(__getSseConnections().has(BOOK)).toBe(false)
  })

  it('满额：建流回 BUSY 429 且探测同 429；探测不改计数；腾出一位后探测即回 200', async () => {
    for (let i = 0; i < MAX_SSE_PER_BOOK; i++) expect(await openStream(FULL_BOOK)).toBe(200)
    await tick()
    expect(__getSseConnections().get(FULL_BOOK)).toBe(MAX_SSE_PER_BOOK)

    // 建流侧：429 + 统一错误信封（文案/码即探测侧 replySseBusy 单源；两处失配本断言即红）
    const busy = await fetch(`${studio.baseUrl}${streamPath(FULL_BOOK)}`, {
      headers: { 'x-studio-token': studio.token },
    })
    expect(busy.status).toBe(429)
    expect(await busy.json()).toEqual({
      code: 'BUSY',
      error: '本书 SSE 连接数已达上限，请关闭多余的标签页/窗口',
    })

    // 探测侧：满额仍给出「忙」的判定，且不占/不改名额
    expect(await probe(FULL_BOOK)).toBe(429)
    await tick()
    expect(__getSseConnections().get(FULL_BOOK)).toBe(MAX_SSE_PER_BOOK)

    // 腾出一位 → 探测立刻回 200（判定读实时账目，无缓存）
    await closeLastStream()
    expect(__getSseConnections().get(FULL_BOOK)).toBe(MAX_SSE_PER_BOOK - 1)
    expect(await probe(FULL_BOOK)).toBe(200)
    // 收尾：本轮全部断开，不污染其他用例
    for (const ac of openStreams.splice(0)) ac.abort()
    await tick()
    expect(__getSseConnections().has(FULL_BOOK)).toBe(false)
  })

  it('凭据闸同口径：无凭据/错 token → 探测与建流同为 403；?token= 旧通道已删（同 403）', async () => {
    const none = { 'x-studio-token': '' }
    expect(await probe(BOOK, none)).toBe(403)
    expect(await openStream(BOOK, none)).toBe(403)
    expect(await probe(BOOK, { 'x-studio-token': 'wrong-token' })).toBe(403)
    // 有效凭据：header 通道（探测/建流通用）
    expect(await probe(BOOK)).toBe(200)
    // R0916-7-P3-19：`?token=` 旧通道已两端同删——query 携带有效长期 token 亦拒（与无凭据同语义）
    expect(await openStream(BOOK, none, `?token=${encodeURIComponent(studio.token)}`)).toBe(403)
  })

  it('Origin 面无第三态：探测与建流对非白名单 Origin 的处置逐字一致（读路径本无 Origin 闸，靠 Host 闸 + 响应侧 CORS 头）', async () => {
    // 裸 http 通道：确保非白名单 Origin 真被发出（fetch/undici 对 Origin 头有自身处置）
    const evil = { origin: 'http://evil.example', 'x-studio-token': studio.token }
    const headStatus = await rawStatus('HEAD', streamPath(BOOK), evil)
    const getStatus = await rawStatus('GET', streamPath(BOOK), evil)
    // 判据：新分支不引入与建流不同的 Origin 处置（HEAD 更严 = 探测在真实跨源头下静默失效；
    // 更松 = 新增放行面）。两侧逐字一致，且与既有读路径口径同值（读路径的跨站读防线在
    // 响应侧 ACAO 白名单 + Host 闸，B-3 未改动该口径）。
    expect(headStatus).toBe(getStatus)
    expect(headStatus).toBe(200)
    await tick()
    expect(__getSseConnections().has(BOOK)).toBe(false)
  })

  it('探测零副作用：带一次性 ticket 的探测不烧票（只 peek），正式流仍可用同一票建流', async () => {
    const issued = await studio.req('POST', '/api/stream-ticket')
    expect(issued.status).toBe(200)
    const ticket = (issued.json as { ticket: string }).ticket
    const q = `?ticket=${encodeURIComponent(ticket)}`
    expect(await probe(BOOK, { 'x-studio-token': '' })).toBe(403) // 对照：完全无凭据仍拒
    // 探测走 ticket 凭据（无 header token）：过预检 → 200
    const headWithTicket = await fetch(`${studio.baseUrl}${streamPath(BOOK, q)}`, { method: 'HEAD' })
    expect(headWithTicket.status).toBe(200)
    // 同一张票仍能建流（未被探测消费）——真实 EventSource 正式连接即 ?ticket= 此形
    expect(await openStream(BOOK, { 'x-studio-token': '' }, q)).toBe(200)
    await closeLastStream()
  })
})
