/**
 * R26-8（二十六轮）/ R26-60（二十六轮）回归：stream.ts 两处修复。
 *
 * - R26-8：runWriterSpawn 失败分支（out.ok=false）的 SSE error 消息过 redactSecret——
 *   provider/SDK 原始报错可能携带 API Key 痕迹，此前未脱敏直接广播（emitSpawnError /
 *   SSE catch 分支同款先例）。测法：桩 runSpec 稳定返回带密钥形态的失败，经隔离路由表
 *   直驱 books.spawn handler（PassThrough 假 req + 捕获型假 res，stream-api.test.ts E-5
 *   同手法），断言 driver.emit 收到的 error 消息已掩码。
 * - R26-60：chat/confirm 确认旗标严格判定（body['ok'] === true）——原 Boolean() 强转把
 *   字符串 'false' 等真值误判成作者确认。桩 resolveChatConfirm 捕获实参断言。
 */
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RouteTable } from '../../src/studio/server/router.js'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { createRouteTable, withRouteTable } from '../../src/studio/server/router.js'
import { resetRouteSchemas } from '../../src/studio/server/api/schema.js'
import { registerStreamRoutes } from '../../src/studio/server/api/stream.js'
import { createStreamTicketStore } from '../../src/studio/server/api/stream-ticket.js'
import type { DriverEvent } from '../../src/driver/index.js'

/** vi.hoisted：mock 工厂在模块导入期执行，共享态必须随 hoist 初始化。 */
const R26 = vi.hoisted(() => ({
  /** 密钥形态字符串（sk- 前缀 + ≥16 位字集，命中 redactSecret 前缀规则） */
  secret: 'sk-r26testsecret1234567890',
  /** fake driver 收到的全部事件（R26-8 断言面） */
  events: [] as Array<Record<string, unknown>>,
}))

// runSpec 桩：spawn 路径稳定走 out.ok=false 失败分支（真实环境「未配 provider」的失败
// 文案不带密钥形态，无法锚定脱敏断言）
vi.mock('../../src/ai/tasks/spec.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/tasks/spec.js')>()
  return {
    ...orig,
    runSpec: async () => ({
      ok: false as const,
      error: `provider 请求失败：Authorization: Bearer ${R26.secret}（401 Unauthorized）`,
    }),
  }
})

// driver 桩：emit 只记账（spawn 的 fire-and-forget 产物经 driver.emit 回流 SSE）
vi.mock('../../src/driver/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/driver/index.js')>()
  return {
    ...orig,
    ensureSession: async () => ({ id: 'r26-fake-session' }),
    getDriver: () => ({
      emit: (_session: unknown, ev: DriverEvent) => {
        R26.events.push(ev as unknown as Record<string, unknown>)
      },
    }),
    getSession: () => null,
  }
})

// resolveChatConfirm 桩：捕获 confirm 端点传入的 ok 实参（R26-60 断言面）
vi.mock('../../src/ai/orchestrate/chat.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/orchestrate/chat.js')>()
  return {
    ...orig,
    resolveChatConfirm: vi.fn(() => true),
  }
})

const BOOK = 'R26流书'
let workDir = ''
let userDataPath = ''

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r26-stream-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-r26-stream-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: R26流书\n  genre: 玄幻\nhost: cc\n',
  )
})

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

/** 注册本文件的隔离路由表，返回按 method+path 取路由的取用器（E-5 测试同手法）。 */
function buildRoutes(): (method: 'GET' | 'POST', path: string) => RouteTable[number] {
  const routes = createRouteTable()
  resetRouteSchemas()
  withRouteTable(routes, () =>
    registerStreamRoutes({ workDir, userDataPath, studioToken: 'r26-token', tickets: createStreamTicketStore() }),
  )
  return (method, path) => {
    const route = routes.find((r) => r.method === method && r.regex.test(path))
    expect(route, `路由未注册：${method} ${path}`).toBeDefined()
    return route!
  }
}

interface FakeRes {
  statusCode: number
  body: string
  headersSent: boolean
  setHeader(): void
  writeHead(code: number): void
  end(chunk?: unknown): void
}

/**
 * 直驱一个 POST 路由 handler：PassThrough 假 req（readJson 走 data/end 事件流）+
 * 捕获型假 res。返回 { status, json }。注意先调 handler（readJson 同步挂监听）再
 * end(body)——PassThrough 无重放，顺序反了数据丢失。
 */
async function callPost(
  route: RouteTable[number],
  name: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const stream = new PassThrough()
  const req = stream as unknown as IncomingMessage
  req.headers = {}
  req.url = '/r26'
  req.method = 'POST'
  const res: FakeRes = {
    statusCode: 0,
    body: '',
    headersSent: false,
    setHeader() {},
    writeHead(code) {
      res.statusCode = code
      res.headersSent = true
    },
    end(chunk) {
      if (chunk) res.body += String(chunk)
    },
  }
  const p = route.handler(req, res as unknown as ServerResponse, { name })
  stream.end(JSON.stringify(body))
  await p
  let json: unknown = null
  try {
    json = JSON.parse(res.body)
  } catch {
    /* 非 JSON 留 null */
  }
  return { status: res.statusCode, json }
}

/** 轮询 R26.events 直到出现 error 事件（fire-and-forget 落定等待，上限 timeoutMs）。 */
async function pollErrorEvent(timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = R26.events.find((e) => e['type'] === 'error')
    if (found) return found
    await new Promise((r) => setTimeout(r, 20))
  }
  return R26.events.find((e) => e['type'] === 'error')
}

// ── R26-8：spawn 失败分支 SSE error 脱敏 ──────────────────

describe('R26-8: books.spawn 失败分支 SSE error 消息脱敏', () => {
  it('out.ok=false → emit 的 error 消息含掩码、不含原始密钥形态串', async () => {
    const getRoute = buildRoutes()
    const spawn = getRoute('POST', `/api/books/${encodeURIComponent(BOOK)}/spawn`)
    const r = await callPost(spawn, BOOK, { prompt: '写一段', role: 'writer' })
    expect(r.status).toBe(200) // fire-and-forget 受理成功

    const err = await pollErrorEvent(2000)
    expect(err, '2s 内未收到 error 事件').toBeDefined()
    expect(err!['type']).toBe('error')
    expect(err!['kind']).toBe('provider')
    const message = String(err!['message'])
    expect(message).toContain('***REDACTED***')
    expect(message).not.toContain(R26.secret)
  })
})

// ── R26-60：chat/confirm 确认旗标严格判定 ─────────────────

describe("R26-60: books.chat.confirm 旗标 body['ok'] === true 严格判定", () => {
  it("字符串 'false' → ok=false（原 Boolean() 强转会误判为 true）", async () => {
    const { resolveChatConfirm } = await import('../../src/ai/orchestrate/chat.js')
    const getRoute = buildRoutes()
    const confirm = getRoute('POST', `/api/books/${encodeURIComponent(BOOK)}/chat/confirm`)
    await callPost(confirm, BOOK, { callId: 'call-1', ok: 'false' })
    const calls = vi.mocked(resolveChatConfirm).mock.calls
    const last = calls[calls.length - 1]!
    expect(last[0]).toBe(BOOK)
    expect(last[1]).toBe('call-1')
    expect(last[2]).toBe(false)
  })

  it('ok: true → ok=true；缺省 → ok=false（契约不回归）', async () => {
    const { resolveChatConfirm } = await import('../../src/ai/orchestrate/chat.js')
    const getRoute = buildRoutes()
    const confirm = getRoute('POST', `/api/books/${encodeURIComponent(BOOK)}/chat/confirm`)
    await callPost(confirm, BOOK, { callId: 'call-2', ok: true })
    await callPost(confirm, BOOK, { callId: 'call-3' })
    const calls = vi.mocked(resolveChatConfirm).mock.calls
    expect(calls[calls.length - 2]![2]).toBe(true)
    expect(calls[calls.length - 1]![2]).toBe(false)
  })
})
