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
import { isSpawnRunning, __setSpawnRunning } from '../../src/studio/server/api/stream.js'

const BOOK = '对话测试书'
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
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
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
