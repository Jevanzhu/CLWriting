/**
 * R30-21（三十轮）回归：driver.stream() 同步抛错时 SSE 连接不再悬挂。
 *
 * 缺陷形态：stream.ts 的 `iter = driver.stream(session)` 在 writeHead(200) 之后裸调——
 * 工厂同步抛错时异常直穿 handler，dispatch 兜底因 headersSent 不回错也不 end，
 * 连接悬挂至客户端自断（心跳未建、无任何字节回流）。
 * 修复：调用包 try/catch——已发头则按既有 SSE 错误事件格式写一条 error event 后
 * end()。本测试锚定行为契约：①首帧 sync 正常；②随后收到 error 事件（message 含
 * 炸点文案）；③流正常结束（r.text() resolve——修复前悬挂至 vitest 超时）；④服务存活。
 *
 * 手法：partial mock src/driver/mock.js——mockDriver.stream 工厂改为同步 throw
 * （startSession/dispose 等保留原实现，ensureSession 正常建会话）；经
 * CLWRITING_DRIVER=mock 让 getDriver() 命中被 mock 的 mockDriver。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import type { DriverEvent } from '../../src/driver/index.js'

const THROW_MSG = 'R30-21 同步炸点：stream 工厂抛错'

vi.mock('../../src/driver/mock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/driver/mock.js')>()
  return {
    ...actual,
    mockDriver: {
      ...actual.mockDriver,
      // 仅 stream 工厂同步 throw（方法体不引用 this，展开保留其余行为安全）
      stream(): AsyncGenerator<DriverEvent> {
        throw new Error(THROW_MSG)
      },
    },
  }
})

const BOOK = 'R30同步炸书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const prevDriver = process.env['CLWRITING_DRIVER']

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clw-r30-sync-throw-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: R30同步炸书\n  genre: 玄幻\n')
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('R30-21: driver.stream() 同步抛错 → SSE 错误事件 + 连接正常收束', () => {
  it('响应含 sync 帧 + error 事件，流正常结束（不悬挂），服务存活', async () => {
    const r = await fetch(
      `${baseUrl}/api/books/${encodeURIComponent(BOOK)}/stream?token=${encodeURIComponent(token)}`,
    )
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    // r.text() 只有服务端 end() 才 resolve——修复前连接悬挂，此处直接超时失败
    const text = await r.text()
    expect(text).toContain('"type":"sync"')
    // SSE 错误事件格式与既有 for-await catch 同款（kind:'stream'，message 已脱敏透传）
    expect(text).toContain('"type":"error"')
    expect(text).toContain('"kind":"stream"')
    expect(text).toContain(THROW_MSG)
    // 服务存活：后续请求正常应答（异常未炸穿 handler/dispatch）
    const boot = await fetch(`${baseUrl}/api/boot`)
    expect(boot.status).toBe(200)
  })
})
