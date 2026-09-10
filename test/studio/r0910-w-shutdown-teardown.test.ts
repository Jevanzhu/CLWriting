/**
 * R0910-W 回归：server.close 自包含化 + 在途外部工作登记（有界等待）。
 *
 * - closeAllSseConnections：在途 SSE 连接随 server.close 断开，close 回调不再悬置；
 * - server.close 回调后置于在途外部工作（Worker 线程）settle——防 close 早于
 *   worker 收尾返回、调用方 close 后立刻 rmSync 落 ENOTEMPTY；
 * - waitInFlightWorkSettled 有界：未 settle 的登记项不无限期阻塞。
 */
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import {
  trackInFlightWork,
  waitInFlightWorkSettled,
  __getInFlightWorkCount,
} from '../../src/studio/server/api/in-flight-work.js'
import { __getSseConnections } from '../../src/studio/server/api/stream.js'

const BOOK = '退出收尾书'
let workDir = ''

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r0910w-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 退出收尾书\n  genre: 玄幻\nhost: cc\n',
  )
})

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R0910-W：在途外部工作登记', () => {
  it('登记返回原 promise、计数可见，settle 即清', async () => {
    expect(__getInFlightWorkCount()).toBe(0)
    let release!: () => void
    const work = new Promise<void>((r) => {
      release = r
    })
    const tracked = trackInFlightWork(work)
    expect(tracked).toBe(work) // 原样返回，不改变调用点语义
    expect(__getInFlightWorkCount()).toBe(1)
    release()
    await work
    await sleep(0)
    expect(__getInFlightWorkCount()).toBe(0)
  })
})

describe('R0910-W：server.close 自包含化', () => {
  it('close 回调后置于在途工作 settle（工作未完成不提前回调）', async () => {
    const server = await startServerSafe({ port: 0, workDir })
    let release!: () => void
    const work = new Promise<void>((r) => {
      release = r
    })
    trackInFlightWork(work)
    let cbAt = 0
    const closed = new Promise<void>((r) => {
      server.close(() => {
        cbAt = Date.now()
        r()
      })
    })
    await sleep(80)
    expect(cbAt).toBe(0) // 在途工作未 settle：回调被有界压住
    release()
    await closed
    expect(cbAt).toBeGreaterThan(0)
  })

  it('在途 SSE 连接随 close 断开，close 回调不悬置、计数随清', async () => {
    const server = await startServerSafe({ port: 0, workDir })
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`
    const token = ((await (await fetch(`${base}/api/boot`)).json()) as { token: string }).token
    const ac = new AbortController()
    const r = await fetch(
      `${base}/api/books/${encodeURIComponent(BOOK)}/stream?token=${encodeURIComponent(token)}`,
      { signal: ac.signal },
    )
    expect(r.status).toBe(200)
    void r.body?.getReader().read().catch(() => { /* abort 后忽略 */ })
    await sleep(50)
    expect(__getSseConnections().get(BOOK)).toBe(1)
    const t0 = Date.now()
    await new Promise<void>((res) => server.close(() => res()))
    // closeAllSseConnections 先 destroy → close 回调及时（不靠调用方超时兜底）
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(__getSseConnections().has(BOOK)).toBe(false)
    ac.abort()
  })
})

// 末测例：留下一个永不 settle 的登记项，专测有界放行（故置于文件末尾，避免
// 影响前序 close 用例的等待时长）。
describe('R0910-W：等待有界', () => {
  it('未 settle 的登记项：有界放行，不无限期阻塞', async () => {
    trackInFlightWork(new Promise<void>(() => { /* 永不 settle */ }))
    const t0 = Date.now()
    await waitInFlightWorkSettled(120)
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(2_000)
    // 该登记项无法 settle，留驻本文件模块态（后续无用例）
    expect(__getInFlightWorkCount()).toBe(1)
  })
})
