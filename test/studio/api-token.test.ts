/**
 * P0 session token 测(GPT-5 P0 defense-in-depth):写端点 token 校验。
 *
 * /api/boot 注入 token;写端点(POST/PUT/DELETE/PATCH)无 token / 错 token → 403;对 token 放行进 dispatch。
 * 与 CORS Origin 校验叠加(双重防跨站)。
 *
 * 约定(X-35)：断言 token 闸本身的请求必须走 node:http rawRequest——vitest setup
 * (helpers/studio-token-setup.ts)全局包装了 fetch,会给 GET /api/* 自动注入 token,
 * 用 fetch 断「无凭据→403」会被包装层救活造成假绿。唯一例外：beforeAll 探 /api/boot
 * 取 token 走包装 fetch 也安全(包装层对 /api/boot 豁免不注入)。
 */
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

let baseUrl = ''
let server: http.Server | undefined
let token = ''
let workDir = ''

function rawRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = '',
): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const u = new URL(baseUrl)
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c.toString('utf8')))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }))
    })
    req.on('error', () => resolve({ status: 0, text: '' }))
    if (body) req.write(body)
    req.end()
  })
}

/** X-20：raw socket 直发请求行——构造 absolute-form 等不经 http.request 归一化的形态 */
function rawSocketRequestLine(requestLine: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const address = server!.address() as AddressInfo
    const sock = net.connect(address.port, '127.0.0.1')
    const timer = setTimeout(() => reject(new Error('2s 内无响应')), 2_000)
    sock.on('connect', () => {
      sock.write(`${requestLine}\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`)
    })
    sock.on('data', (d) => {
      clearTimeout(timer)
      const raw = d.toString('utf8')
      const statusLine = raw.split('\r\n')[0] ?? ''
      const bodyStart = raw.indexOf('\r\n\r\n')
      sock.destroy()
      resolve({ status: Number(statusLine.split(' ')[1] ?? 0), text: bodyStart === -1 ? '' : raw.slice(bodyStart + 4) })
    })
    sock.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-token-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  mkdirSync(join(workDir, 't'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), '{"name":"t","path":"t"}\n')
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  const d = (await r.json()) as { token: string }
  token = d.token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('P0 session token(写端点 defense-in-depth)', () => {
  it('GET /api/boot 返非空 token', () => {
    expect(token.length).toBeGreaterThan(10)
  })

  it('PUT 无 X-Studio-Token(Origin 白名单)→ 403', async () => {
    const r = await rawRequest('PUT', `/api/books/${encodeURIComponent('x')}/settings/character`, { origin: baseUrl })
    expect(r.status).toBe(403)
  })

  it('PUT 错 token → 403', async () => {
    const r = await rawRequest('PUT', `/api/books/${encodeURIComponent('x')}/settings/character`, {
      origin: baseUrl,
      'x-studio-token': 'wrong-token',
    })
    expect(r.status).toBe(403)
  })

  it('PUT 对 token(Origin 白名单)→ 非 403(过 token 门进 dispatch)', async () => {
    const r = await rawRequest('PUT', `/api/books/${encodeURIComponent('x')}/settings/character`, {
      origin: baseUrl,
      'x-studio-token': token,
    })
    // R72-19（二十轮 G-4）：负向弱断言收紧——not.toBe(403) 连 500/502 都放行；
    // 该端点对不存在书籍落 404，白名单口径显式圈定过门后的合法状态集
    expect([400, 404, 422]).toContain(r.status)
  })

  // P0-1 守护：PATCH 方法必须走 isWrite 校验（2026-08-10 评审发现 isWrite 曾遗漏 PATCH）
  it('PATCH 无 X-Studio-Token → 403', async () => {
    const r = await rawRequest('PATCH', `/api/books/${encodeURIComponent('t')}/documents/doc_x`, {
      origin: baseUrl,
      'content-type': 'application/json',
    }, JSON.stringify({ op: 'rename', newName: 'y' }))
    expect(r.status).toBe(403)
  })

  it('PATCH 错 token → 403', async () => {
    const r = await rawRequest('PATCH', `/api/books/${encodeURIComponent('t')}/documents/doc_x`, {
      origin: baseUrl,
      'content-type': 'application/json',
      'x-studio-token': 'wrong-token',
    }, JSON.stringify({ op: 'rename', newName: 'y' }))
    expect(r.status).toBe(403)
  })

  it('PATCH 对 token → 非 403(过 token 门进 dispatch)', async () => {
    const r = await rawRequest('PATCH', `/api/books/${encodeURIComponent('x')}/documents/doc_x`, {
      origin: baseUrl,
      'content-type': 'application/json',
      'x-studio-token': token,
    }, JSON.stringify({ op: 'rename', newName: 'y' }))
    expect(r.status).not.toBe(403)
  })

  // T2-3：GET /api/* 读端点同样要求 token——此前只拦写，读端点可无凭据全量读取
  it('GET 无 token → 403(T2-3 读端点闸)', async () => {
    const r = await rawRequest('GET', '/api/books', {})
    expect(r.status).toBe(403)
  })

  it('GET 错 token → 403', async () => {
    const r = await rawRequest('GET', '/api/books', { 'x-studio-token': 'wrong-token' })
    expect(r.status).toBe(403)
  })

  it('GET 对 token(x-studio-token 头)→ 200', async () => {
    const r = await rawRequest('GET', '/api/books', { 'x-studio-token': token })
    expect(r.status).toBe(200)
  })

  // S7（五十九轮）：query token 通道收窄——原 `?token=` 对全部非豁免 GET 通用（token
  // 进 URL 暴露面大于 SSE 最小必要面），现非豁免 GET 只认 x-studio-token 头；
  // `?token=` 仅 SSE 豁免路径放行（stream.ts 自身凭据闸校验）。契约变更同步本测试。
  it('S7: GET query token（非豁免路径）→ 403（通道收窄，只认头鉴权）', async () => {
    const r = await rawRequest('GET', `/api/books?token=${encodeURIComponent(token)}`, {})
    expect(r.status).toBe(403)
  })

  it('GET /api/boot 免鉴权 → 200(bootstrap 通道豁免)', async () => {
    const r = await rawRequest('GET', '/api/boot', {})
    expect(r.status).toBe(200)
  })

  // R65-46（总六十五轮）：HEAD 与 GET 同读语义，一并入闸——原只判 GET，HEAD /api/*
  // 绕过 token 校验（当前无 HEAD 路由无实害，口径不一致留缺口）
  it('R65-46: HEAD 无 token → 403（与 GET 同闸，原仅判 GET 可绕过）', async () => {
    const r = await rawRequest('HEAD', '/api/books', {})
    expect(r.status).toBe(403)
  })

  it('R65-46 对照: HEAD 对 token → 非 403（过闸进 dispatch，无匹配路由 404）', async () => {
    const r = await rawRequest('HEAD', '/api/books', { 'x-studio-token': token })
    expect(r.status).not.toBe(403)
  })

  it('POST 超过 JSON body 上限 → 413', async () => {
    const body = JSON.stringify({ format: 'x'.repeat(1024 * 1024 + 1) })
    const r = await rawRequest(
      'POST',
      '/api/books/t/export',
      {
        origin: baseUrl,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'x-studio-token': token,
      },
      body,
    )
    expect(r.status).toBe(413)
  })
})

// X-19（第五十六轮）：GET 闸豁免改显式路径表——原 endsWith('/stream') 后缀匹配下任何
// 尾段撞 /stream 的路径都静默失闸；豁免面收敛为 /api/boot + /api/books/:name/stream。
describe('X-19: GET token 闸豁免显式路径表', () => {
  it('SSE 端点 /api/books/:name/stream 仍豁免——过 index 闸后被 stream.ts 自身凭据闸拦截（error=forbidden）', async () => {
    const r = await rawRequest('GET', '/api/books/t/stream', {})
    expect(r.status).toBe(403)
    // index 闸文案是「无效或缺失的 studio token」，stream.ts 自身闸是 'forbidden'——
    // 拿到后者即证明请求穿过了 index 闸豁免（而非被 index 闸拦截）
    expect(JSON.parse(r.text)).toEqual({ code: 'FORBIDDEN', error: 'forbidden' })
  })

  it('尾段撞车的非 SSE 路径不再豁免：无 token → 403；对 token 过闸后走 dispatch 404', async () => {
    // 修复前：endsWith('/stream') 命中 → 豁免放行 → dispatch 无此路由回 404（失闸）
    const no = await rawRequest('GET', '/api/notexist/stream', {})
    expect(no.status).toBe(403)
    expect((JSON.parse(no.text) as { error: string }).error).toContain('studio token')
    const yes = await rawRequest('GET', '/api/notexist/stream', { 'x-studio-token': token })
    expect(yes.status).toBe(404)
  })

  it('/api/boot 豁免不受影响；深一级的 boot 路径不误豁免', async () => {
    expect((await rawRequest('GET', '/api/boot', {})).status).toBe(200)
    expect((await rawRequest('GET', '/api/boot/x', {})).status).toBe(403)
  })
})

// X-20（第五十六轮）：absolute-form 请求行——origin-form（以 / 起始）是 node http 服务端
// 唯一合法形态；absolute-form 此前绕过 /api 前缀判断落静态分支回 200 HTML。
describe('X-20: absolute-form 请求行入口拒绝', () => {
  it('GET http://…/api/* → 400（非 200 HTML、非 404）', async () => {
    const address = server!.address() as AddressInfo
    const r = await rawSocketRequestLine(`GET http://127.0.0.1:${address.port}/api/books HTTP/1.1`)
    expect(r.status).toBe(400)
    // raw socket 侧 body 是 chunked 编码（带块长前缀），断言子串而非 JSON.parse
    expect(r.text).toContain('"code":"BAD_INPUT"')
    expect(r.text).not.toContain('<!doctype') // 不是静态分支的 200 HTML
  })

  it('对照：origin-form 同路径行为不变（无 token → 403 过闸校验）', async () => {
    const r = await rawSocketRequestLine('GET /api/books HTTP/1.1')
    expect(r.status).toBe(403)
  })
})

// ── R65-64（F-5）：GET 路由 token 闸穷举网 ───────────────────────
/** 从路由源码静态抽取全部 GET path（新注册的 GET 端点自动入网，不靠手工同步清单）。
 *  抽取口径与 defineRoute 定义同形：method: 'GET', 换行 path: '...'。 */
function extractGetRoutePaths(): string[] {
  const apiDir = join(import.meta.dirname, '../../src/studio/server/api')
  const files = [
    ...readdirSync(apiDir).filter((f) => f.endsWith('.ts')).map((f) => join(apiDir, f)),
    join(import.meta.dirname, '../../src/studio/server/index.ts'),
  ]
  const paths = new Set<string>()
  for (const fp of files) {
    const m = readFileSync(fp, 'utf8').matchAll(/method: 'GET',\s*\n\s*path: '([^']+)'/g)
    for (const hit of m) paths.add(hit[1]!)
  }
  return [...paths].sort()
}

describe('R65-64（F-5）：全量 GET /api/* 无 token → 403（豁免表除外）', () => {
  it('穷举源码中每一条 GET 路由的实例化路径，无凭据一律 403', async () => {
    const patterns = extractGetRoutePaths()
    expect(patterns.length, '路由抽取不得为空——defineRoute 结构变更须同步抽取正则').toBeGreaterThan(30)

    // :param 实例化（值进不了 handler——token 闸先于 dispatch；403 与业务态无关）
    const concrete = (p: string) =>
      p.replaceAll(':name', 't').replaceAll(':docId', 'doc_x').replaceAll(':id', 'snap1').replaceAll(':kind', 'review')
    // index.ts 的 GET 豁免表同源（boot 取 token 本身 + SSE 流）
    const exempt = [/^\/api\/boot$/, /^\/api\/books\/[^/]+\/stream$/]

    const leaks: string[] = []
    for (const p of patterns) {
      const path = concrete(p)
      if (exempt.some((re) => re.test(path))) continue
      const r = await rawRequest('GET', path)
      if (r.status !== 403) leaks.push(`${path} → ${r.status}（期望 403）`)
    }
    expect(leaks, '以下 GET 路由无凭据未返回 403（token 闸失守）:\n' + leaks.join('\n')).toEqual([])
  })

  it('抽查带正确 token → 同批路径不再 403（闸只拦无凭据，不误伤读端点）', async () => {
    for (const p of ['/api/books', '/api/books/t/tree', '/api/books/t/state']) {
      const r = await rawRequest('GET', p, { 'x-studio-token': token })
      expect(r.status, `${p}`).not.toBe(403)
    }
  })
})
