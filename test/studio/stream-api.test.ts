/**
 * stream.ts 端点 HTTP 层集成测试（评审测试缺口补强）。
 *
 * 覆盖 6 个写端点的入口校验 + 同步端点正常路径。
 * fire-and-forget 端点（spawn/auto-write/chat）只验 HTTP 响应码，
 * 不等后台 AI 执行（那部分由底层单测 + e2e 兜底）。
 *
 * 测试环境无 provider 配置 → 后台任务因 NO_PROVIDER 快速失败，无副作用。
 *
 * ee-P2-11：/spawn 在途闸 × 删书/改名 409（经 __setSpawnRunning 夹具，不起真实生成）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { isSpawnRunning, __setSpawnRunning, registerStreamRoutes } from '../../src/studio/server/api/stream.js'
import { createRouteTable, withRouteTable, dispatch } from '../../src/studio/server/router.js'
import { resetRouteSchemas } from '../../src/studio/server/api/schema.js'

const BOOK = '对话测试书'
/** S5（五十九轮）：全书零触碰的书（/interrupt 空闲 no-op 回归用） */
const IDLE_BOOK = '中断空转书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

interface ReqOpts {
  method: string
  path: string
  body?: unknown
}

/** 带 token 的 JSON 请求，返回 { status, json }。 */
function req<T = unknown>(opts: ReqOpts): Promise<{ status: number; json: T }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: opts.path,
        method: opts.method,
        headers: {
          'content-type': 'application/json',
          origin: baseUrl,
          'x-studio-token': token,
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: T = null as T
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 留 null */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (opts.body !== undefined) r.write(JSON.stringify(opts.body))
    r.end()
  })
}

/** 拼本书端点路径。 */
function bp(suffix: string): string {
  return `/api/books/${encodeURIComponent(BOOK)}${suffix}`
}

/** 不存在的书名（已编码，用于 404 测试）。 */
const NO_BOOK = encodeURIComponent('不存在')

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-stream-api-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-stream-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    // S5（五十九轮）：IDLE_BOOK 专用——全书全程无 session/SSE/编排触碰，验 /interrupt
    // 空闲 no-op 不隐式建会话
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n' +
      JSON.stringify({ name: IDLE_BOOK, path: IDLE_BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(workDir, IDLE_BOOK), { recursive: true })
  writeFileSync(
    join(workDir, IDLE_BOOK, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 中断空转书\n  genre: 玄幻\nhost: cc\n',
  )
  mkdirSync(join(bookRoot, '定稿', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 对话测试书\n  genre: 玄幻\nhost: cc\n',
  )

  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  // 等 fire-and-forget 后台任务（NO_PROVIDER 快速失败）落定
  await new Promise((r) => setTimeout(r, 300))
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  rmSync(workDir, { recursive: true, force: true })
  rmSync(userDataPath, { recursive: true, force: true })
})

// ── 入口校验（不触发 fire-and-forget） ──────────────────

describe('stream 端点入口校验', () => {
  it('POST /spawn 无书 → 404', async () => {
    const r = await req({ method: 'POST', path: `/api/books/${NO_BOOK}/spawn`, body: { prompt: 't' } })
    expect(r.status).toBe(404)
  })

  it('POST /spawn 空 prompt → 400', async () => {
    const r = await req({ method: 'POST', path: bp('/spawn'), body: { prompt: '' } })
    expect(r.status).toBe(400)
  })

  it('POST /spawn 仅空白 prompt → 400', async () => {
    const r = await req({ method: 'POST', path: bp('/spawn'), body: { prompt: '   ' } })
    expect(r.status).toBe(400)
  })

  it('POST /interrupt 无书 → 404', async () => {
    const r = await req({ method: 'POST', path: `/api/books/${NO_BOOK}/interrupt` })
    expect(r.status).toBe(404)
  })

  it('POST /auto-write 无书 → 404', async () => {
    const r = await req({ method: 'POST', path: `/api/books/${NO_BOOK}/auto-write`, body: { chapter: 1 } })
    expect(r.status).toBe(404)
  })

  it('POST /auto-write 非整数 chapter → 400', async () => {
    const r = await req({ method: 'POST', path: bp('/auto-write'), body: { chapter: 'abc' } })
    expect(r.status).toBe(400)
  })

  it('POST /auto-write chapter < 1 → 400', async () => {
    const r = await req({ method: 'POST', path: bp('/auto-write'), body: { chapter: 0 } })
    expect(r.status).toBe(400)
  })

  it('POST /chat 无书 → 404', async () => {
    const r = await req({ method: 'POST', path: `/api/books/${NO_BOOK}/chat`, body: { message: 'hi' } })
    expect(r.status).toBe(404)
  })

  it('POST /chat 空 message → 400', async () => {
    const r = await req({ method: 'POST', path: bp('/chat'), body: { message: '' } })
    expect(r.status).toBe(400)
  })

  it('POST /chat/confirm 无 callId → 400', async () => {
    const r = await req({ method: 'POST', path: bp('/chat/confirm'), body: { ok: true } })
    expect(r.status).toBe(400)
  })

  it('POST /chat/confirm 无挂起 callId → 404', async () => {
    const r = await req({ method: 'POST', path: bp('/chat/confirm'), body: { callId: 'fake', ok: true } })
    expect(r.status).toBe(404)
  })
})

// ── 同步端点正常路径 ──────────────────────────────────

describe('stream 同步端点正常路径', () => {
  it('POST /interrupt → 200', async () => {
    const r = await req({ method: 'POST', path: bp('/interrupt') })
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)
  })

  it('POST /chat/clear → 200', async () => {
    const r = await req({ method: 'POST', path: bp('/chat/clear') })
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)
  })
})

// ── fire-and-forget 正常路径（只验 HTTP 200） ───────────

describe('stream fire-and-forget 正常响应', () => {
  it('POST /spawn 正常 → 200', async () => {
    const r = await req({ method: 'POST', path: bp('/spawn'), body: { prompt: '写一段', role: 'writer' } })
    expect(r.status).toBe(200)
  })

  it('POST /chat 正常 → 200', async () => {
    const r = await req({ method: 'POST', path: bp('/chat'), body: { message: '你好' } })
    expect(r.status).toBe(200)
  })

  it('POST /auto-write 正常 → 200', async () => {
    const r = await req({ method: 'POST', path: bp('/auto-write'), body: { chapter: 1 } })
    expect(r.status).toBe(200)
  })
})

// ── RB-SV-P2-1：/spawn 并发闸 ──────────────────────────

describe('RB-SV-P2-1 /spawn 并发闸', () => {
  it('已在跑（闸被持有）→ 409；释放后 → 200', async () => {
    __setSpawnRunning(BOOK, true)
    try {
      const busy = await req({ method: 'POST', path: bp('/spawn'), body: { prompt: '写一段' } })
      expect(busy.status).toBe(409)
      expect((busy.json as { error: string }).error).toContain('生成')
    } finally {
      __setSpawnRunning(BOOK, false)
    }
    const ok = await req({ method: 'POST', path: bp('/spawn'), body: { prompt: '写一段' } })
    expect(ok.status).toBe(200)
  })

  it('闸未启动的早退路径（空 prompt 400）不泄漏闸——后续 spawn 仍可 200', async () => {
    const bad = await req({ method: 'POST', path: bp('/spawn'), body: { prompt: '  ' } })
    expect(bad.status).toBe(400)
    expect(isSpawnRunning(BOOK)).toBe(false)
    const ok = await req({ method: 'POST', path: bp('/spawn'), body: { prompt: '写一段' } })
    expect(ok.status).toBe(200)
  })
})

// ── E-5（第五十三轮）：SSE 端点畸形 URL → 400 而非 500 ──
// 口径对齐 R-19（第十六轮）parseRequestUrl。说明：绝对畸形请求行（`GET http://[bad`）
// 不以 /api/ 开头，在 index.ts 即落入静态分支，不经 SSE handler——故 E-5 的回归在
// dispatch 层与 stream handler 层分别直接验证：任一层遇畸形 URL 均回 400 BAD_INPUT
// 信封，而非 handler 内抛 TypeError 变 500。

describe('E-5 SSE 端点畸形 URL 回 400', () => {
  /** 构造捕获型假 res（记录状态码与响应体）。 */
  function fakeRes() {
    const r = {
      statusCode: 0,
      headersSent: false,
      body: '',
      headers: {} as Record<string, unknown>,
      setHeader(k: string, v: unknown) { r.headers[k] = v },
      writeHead(code: number, h: Record<string, unknown>) { r.statusCode = code; Object.assign(r.headers, h ?? {}) },
      end(chunk?: unknown) { if (chunk) r.body += String(chunk) },
    }
    return r
  }

  it('dispatch 层：畸形 absolute-form req.url → 400 BAD_INPUT 信封（非 500）', async () => {
    const routes = createRouteTable()
    resetRouteSchemas()
    withRouteTable(routes, () => registerStreamRoutes({ workDir, userDataPath, studioToken: token }))
    const res = fakeRes()
    const matched = await dispatch(
      { method: 'GET', url: 'http://[bad/api/books/x/stream', headers: {} } as unknown as import('node:http').IncomingMessage,
      res as unknown as import('node:http').ServerResponse,
      routes,
    )
    expect(matched).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ code: 'BAD_INPUT', error: 'bad request' })
  })

  it('stream handler 层：畸形 req.url → 400 BAD_INPUT 而非抛 TypeError（修复前裸 new URL 抛错 → 500）', async () => {
    const routes = createRouteTable()
    resetRouteSchemas()
    withRouteTable(routes, () => registerStreamRoutes({ workDir, userDataPath, studioToken: token }))
    // 从路由表取出 SSE 路由，直接调 handler（绕过 dispatch 的前置 parse，
    // 专验 E-5 修复点：handler 自身对畸形 URL 的兜底）
    const streamRoute = routes.find((r) => r.method === 'GET' && r.regex.test('/api/books/x/stream'))
    expect(streamRoute).toBeDefined()
    const res = fakeRes()
    await expect(
      streamRoute!.handler(
        { method: 'GET', url: 'http://[bad', headers: {} } as unknown as import('node:http').IncomingMessage,
        res as unknown as import('node:http').ServerResponse,
        { name: BOOK },
      ),
    ).resolves.toBeUndefined()
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ code: 'BAD_INPUT', error: 'bad request' })
  })
})

// ── ee-P2-11：删书/改名查 /spawn 在途闸 ────────────────
// spawn 是分钟级网络任务且 runWriterSpawn 持 bookRoot 闭包——漏查闸则删/改名后
// 收尾写旧路径（重建孤儿目录）+ 白烧费用。驱动方式：__setSpawnRunning 确定性夹具
// （模块导出的并发 409 测试钩子，见 stream.ts），不起真实生成。

describe('ee-P2-11 删书/改名查 /spawn 在途闸', () => {
  /** 登记一本独立测试书（保留共享 BOOK 条目），返回其目录绝对路径。 */
  function registerBook(name: string): string {
    writeFileSync(
      join(workDir, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n' +
        JSON.stringify({ name, path: `长篇/${name}`, kind: 'long' }) + '\n',
    )
    const bookRoot = join(workDir, '长篇', name)
    mkdirSync(bookRoot, { recursive: true })
    writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${name}\n  genre: 玄幻\nhost: cc\n`)
    return bookRoot
  }

  it('spawn 运行中删书 → 409；释放后 → 200（本测自建自删，不动共享 BOOK）', async () => {
    const NAME = 'spawn闸删书测试书'
    registerBook(NAME)

    __setSpawnRunning(NAME, true)
    try {
      const busy = await req({ method: 'DELETE', path: `/api/books/${encodeURIComponent(NAME)}` })
      expect(busy.status).toBe(409)
      expect((busy.json as { error: string }).error).toContain('生成')
    } finally {
      __setSpawnRunning(NAME, false)
    }
    const ok = await req({ method: 'DELETE', path: `/api/books/${encodeURIComponent(NAME)}` })
    expect(ok.status).toBe(200)
  })

  it('spawn 运行中改名 → 409；释放后 → 200', async () => {
    const NAME = 'spawn闸改名测试书'
    registerBook(NAME)

    __setSpawnRunning(NAME, true)
    try {
      const busy = await req({
        method: 'POST',
        path: `/api/books/${encodeURIComponent(NAME)}/rename`,
        body: { name: 'spawn闸改名新名' },
      })
      expect(busy.status).toBe(409)
      expect((busy.json as { error: string }).error).toContain('生成')
    } finally {
      __setSpawnRunning(NAME, false)
    }
    const ok = await req({
      method: 'POST',
      path: `/api/books/${encodeURIComponent(NAME)}/rename`,
      body: { name: 'spawn闸改名新名' },
    })
    expect(ok.status).toBe(200)
    expect((ok.json as { ok: boolean }).ok).toBe(true)
  })
})

// ── S5（五十九轮）：/interrupt 空闲 no-op ─────────────────

describe('S5: /interrupt 无运行 → 成功 no-op，不隐式建会话', () => {
  it('无 session / 无编排在途 → 200 ok，且不 ensureSession（getSession 仍为 null）', async () => {
    const { getSession } = await import('../../src/driver/index.js')
    // ee-P2-11 段的 registerBook 会整写 books.jsonl（只留 BOOK+NAME）——此处补登记
    // IDLE_BOOK（幂等；目录/book.yaml beforeAll 已备）
    writeFileSync(
      join(workDir, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n' +
        JSON.stringify({ name: IDLE_BOOK, path: IDLE_BOOK, kind: 'long' }) + '\n',
    )
    expect(getSession(IDLE_BOOK)).toBeNull() // 前置：该书确无会话
    const r = await req({ method: 'POST', path: `/api/books/${encodeURIComponent(IDLE_BOOK)}/interrupt` })
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)
    // 原实现无条件 ensureSession → 静默新建 channel（永不 dispose）；现 no-op 不建
    expect(getSession(IDLE_BOOK)).toBeNull()
  })

  it('spawn 在途 → 走真实中断路径（不 no-op）', async () => {
    __setSpawnRunning(BOOK, true)
    try {
      // spawn 闸在途时 isRunning 判真 → ensureSession + driver.interrupt 正常执行（200）
      const r = await req({ method: 'POST', path: bp('/interrupt') })
      expect(r.status).toBe(200)
      expect((r.json as { ok: boolean }).ok).toBe(true)
    } finally {
      __setSpawnRunning(BOOK, false)
    }
  })
})
