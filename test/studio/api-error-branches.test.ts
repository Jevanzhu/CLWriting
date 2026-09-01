/**
 * kk-P2-15 回归测试：服务端 API 错误分支系统覆盖（prefs / state / ai-status 三低覆盖面）。
 *
 * 正常路径已有集成测（prefs-revision / state-batch-pause / ai-status 等），本文件补
 * 错误与降级分支：坏 body（非法 JSON / prefs 非对象）、书不存在（404 信封）、
 * 盘上文件损坏的静默降级（prefs.json / global.json / book.yaml）、无 userDataPath
 * 的 CLI 形态（NO_USERDATA / 未定位数据目录）、ai-status 探测降级梯
 * （未配置 → 未测试连接 → 无模型档位 → 可达 + e2e 短路）。
 * 全部走真实 startServer HTTP（与既有 api 集成测同口径）；非法 token 的全局行为
 * 已由 api-token.test.ts 覆盖，此处不重复。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, afterEach } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { startServerSafe } from '../helpers/safe-port.js'

let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

// 无 userDataPath 的 CLI 形态服务（NO_USERDATA / 未定位数据目录 两分支专用）
let cliWorkDir = ''
let cliServer: http.Server | undefined
let cliBaseUrl = ''
let cliToken = ''

let prevDriver: string | undefined
let prevAiDown: string | undefined

interface ReqOpts {
  method: string
  path: string
  /** 结构化 body（JSON 序列化后发送） */
  body?: unknown
  /** 原始 body 字符串（构造非法 JSON 用；与 body 互斥，优先于 body） */
  rawBody?: string
}
function request(base: string, tok: string, opts: ReqOpts): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base)
    const payload = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: opts.path,
        method: opts.method,
        headers: {
          'x-studio-token': tok,
          ...(payload !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: any = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 体 */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (payload !== undefined) r.write(payload)
    r.end()
  })
}
function req(opts: ReqOpts): Promise<{ status: number; json: any }> {
  return request(baseUrl, token, opts)
}
function cliReq(opts: ReqOpts): Promise<{ status: number; json: any }> {
  return request(cliBaseUrl, cliToken, opts)
}

/** 建一本最小书（books.jsonl 登记 + book.yaml 可选内容） */
function makeBook(name: string, bookYaml: string): string {
  const rel = `books/${name}`
  const root = join(workDir, rel)
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), bookYaml)
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  const reg = join(workDir, '.clwriting', 'books.jsonl')
  writeFileSync(reg, `${JSON.stringify({ name, path: rel })}\n`, { flag: 'a' })
  return root
}

beforeAll(async () => {
  // ai-status 探测分支需要非 mock 驱动（mock 永可达短路）——按 ai-status.test.ts 同款保存/恢复
  prevDriver = process.env.CLWRITING_DRIVER
  prevAiDown = process.env.CLWRITING_E2E_AI_DOWN
  delete process.env.CLWRITING_DRIVER
  delete process.env.CLWRITING_E2E_AI_DOWN

  workDir = mkdtempSync(join(tmpdir(), 'clwriting-api-err-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-api-err-ud-'))
  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  token = ((await (await fetch(`${baseUrl}/api/boot`)).json()) as { token: string }).token

  cliWorkDir = mkdtempSync(join(tmpdir(), 'clwriting-api-err-cli-'))
  cliServer = startServer({ port: 0, workDir: cliWorkDir })
  await new Promise<void>((r) => cliServer!.once('listening', r))
  cliBaseUrl = `http://127.0.0.1:${(cliServer!.address() as AddressInfo).port}`
  cliToken = ((await (await fetch(`${cliBaseUrl}/api/boot`)).json()) as { token: string }).token
})

afterAll(async () => {
  if (prevDriver === undefined) delete process.env.CLWRITING_DRIVER
  else process.env.CLWRITING_DRIVER = prevDriver
  if (prevAiDown === undefined) delete process.env.CLWRITING_E2E_AI_DOWN
  else process.env.CLWRITING_E2E_AI_DOWN = prevAiDown
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (cliServer) await new Promise<void>((r) => cliServer!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
  if (cliWorkDir) rmSync(cliWorkDir, { recursive: true, force: true })
})

afterEach(() => {
  // e2e 短路只在单测内生效，逐测清干净防串扰
  delete process.env.CLWRITING_E2E_AI_DOWN
})

// ── prefs 书级 ──────────────────────────────────────────────

describe('kk-P2-15：书级 prefs 错误分支', () => {
  it('GET 不存在的书 → 404 NOT_FOUND 信封', async () => {
    const r = await req({ method: 'GET', path: `/api/books/${encodeURIComponent('无此书')}/prefs` })
    expect(r.status).toBe(404)
    expect(r.json.code).toBe('NOT_FOUND')
    expect(r.json.error).toContain('没有这本书')
  })

  it('GET prefs.json 损坏 → 200 静默降级空偏好（不炸不 5xx）', async () => {
    makeBook('坏prefs', 'kind: long\n')
    mkdirSync(join(workDir, 'books/坏prefs/.clwriting'), { recursive: true })
    writeFileSync(join(workDir, 'books/坏prefs/.clwriting/prefs.json'), '{oops 不是 json')
    const r = await req({ method: 'GET', path: `/api/books/${encodeURIComponent('坏prefs')}/prefs` })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ prefs: {} })
  })

  it('PUT body 非法 JSON → 400 BAD_INPUT（readJson 兜底信封）', async () => {
    makeBook('书A', 'kind: long\n')
    const r = await req({ method: 'PUT', path: `/api/books/${encodeURIComponent('书A')}/prefs`, rawBody: '{"prefs": ' })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('BAD_INPUT')
    expect(r.json.error).toContain('不是合法 JSON')
  })

  it('PUT prefs 缺失/非对象/数组 → 400 BAD_INPUT 三态', async () => {
    makeBook('书B', 'kind: long\n')
    for (const bad of [{}, { prefs: '字符串' }, { prefs: [1, 2] }]) {
      const r = await req({ method: 'PUT', path: `/api/books/${encodeURIComponent('书B')}/prefs`, body: bad })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('BAD_INPUT')
      expect(r.json.error).toContain('prefs')
    }
  })

  it('PUT 合法偏好 → 200 且 GET 回读一致（错误分支的正向对照）', async () => {
    makeBook('书C', 'kind: long\n')
    const put = await req({ method: 'PUT', path: `/api/books/${encodeURIComponent('书C')}/prefs`, body: { prefs: { leftWidth: 260 } } })
    expect(put.status).toBe(200)
    expect(put.json.ok).toBe(true)
    const got = await req({ method: 'GET', path: `/api/books/${encodeURIComponent('书C')}/prefs` })
    expect(got.status).toBe(200)
    expect(got.json.prefs).toEqual({ leftWidth: 260 })
  })
})

// ── prefs 全局（library）──────────────────────────────────

describe('kk-P2-15：全局 prefs 损坏降级', () => {
  it('GET global.json 损坏 → 200 {prefs:{}, revision:0}', async () => {
    writeFileSync(join(userDataPath, 'global.json'), '{broken')
    const r = await req({ method: 'GET', path: '/api/library/prefs' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ prefs: {}, revision: 0 })
  })

  it('PUT global.json 损坏 → 视作 revision 0 整体重写（200 + 文件修复为合法 JSON）', async () => {
    writeFileSync(join(userDataPath, 'global.json'), '{broken')
    const r = await req({ method: 'PUT', path: '/api/library/prefs', body: { prefs: { theme: 'light' } } })
    expect(r.status).toBe(200)
    expect(r.json.revision).toBe(1)
    const got = await req({ method: 'GET', path: '/api/library/prefs' })
    expect(got.json).toEqual({ prefs: { theme: 'light' }, revision: 1 })
  })

  it('无 userDataPath（CLI 形态）→ 400 NO_USERDATA', async () => {
    const g = await cliReq({ method: 'GET', path: '/api/library/prefs' })
    expect(g.status).toBe(400)
    expect(g.json.code).toBe('NO_USERDATA')
    const p = await cliReq({ method: 'PUT', path: '/api/library/prefs', body: { prefs: {} } })
    expect(p.status).toBe(400)
    expect(p.json.code).toBe('NO_USERDATA')
  })
})

// ── state ──────────────────────────────────────────────────

describe('kk-P2-15：state 端点错误与降级分支', () => {
  it('不存在的书 → 404 NOT_FOUND 信封', async () => {
    const r = await req({ method: 'GET', path: `/api/books/${encodeURIComponent('不存在')}/state` })
    expect(r.status).toBe(404)
    expect(r.json.code).toBe('NOT_FOUND')
  })

  it('book.yaml 损坏 → 200 静默降级默认配置（不 5xx）', async () => {
    makeBook('坏yaml', 'kind: [broken\n')
    const r = await req({ method: 'GET', path: `/api/books/${encodeURIComponent('坏yaml')}/state` })
    expect(r.status).toBe(200)
    expect(typeof r.json.stateName).toBe('string')
    expect(r.json.kind).toBe('long') // 默认配置回落
  })

  it('正常书对照 → 200 带态机字段', async () => {
    makeBook('正常书', 'kind: long\n')
    const r = await req({ method: 'GET', path: `/api/books/${encodeURIComponent('正常书')}/state` })
    expect(r.status).toBe(200)
    expect(typeof r.json.state).toBe('number')
    expect(typeof r.json.humanMsg).toBe('string')
    expect(typeof r.json.nextChapter).toBe('number')
  })
})

// ── book.yaml 损坏：单书端点显式 500（第九轮 L-1 / 第十轮 低-2）────────

describe('kk-P2-15：book.yaml 损坏 → 单书端点显式 500（真实错误文案）', () => {
  // 损坏形态：有值键后跟更深缩进行——parseSections 唯一显式抛错的语法错误（ii 批 ff P2-2）
  const BROKEN = 'kind: long\n  孤儿子行\n'

  it('M-6（第十轮，回归第九轮 L-1）：GET /api/books/:name 对损坏 book.yaml → 500 IO（不代答默认身份）', async () => {
    makeBook('坏身份', BROKEN)
    const r = await req({ method: 'GET', path: `/api/books/${encodeURIComponent('坏身份')}` })
    expect(r.status).toBe(500)
    expect(r.json.code).toBe('IO_ERROR')
    expect(r.json.error).toContain('book.yaml')
  })

  it('低-2（第十轮）：单书身份 500 文案含真实解析错误、不串成 [object Object]', async () => {
    makeBook('坏文案', BROKEN)
    const r = await req({ method: 'GET', path: `/api/books/${encodeURIComponent('坏文案')}` })
    expect(r.status).toBe(500)
    expect(r.json.error).not.toContain('[object Object]')
    // readBookConfig 错误分支的 ParseError {file,line,message}——须取 .message 展示
    expect(r.json.error).toContain('解析失败')
  })

  it('低-2（第十轮）：GET /api/books/:name/config 同场景 500 文案不串成 [object Object]', async () => {
    makeBook('坏配置', BROKEN)
    const r = await req({ method: 'GET', path: `/api/books/${encodeURIComponent('坏配置')}/config` })
    expect(r.status).toBe(500)
    expect(r.json.code).toBe('IO_ERROR')
    expect(r.json.error).not.toContain('[object Object]')
    expect(r.json.error).toContain('解析失败')
  })
  it('低-3（第十轮）：书架列表对损坏 book.yaml 显式标 damaged，健康书无该字段', async () => {
    makeBook('列表健康书', 'kind: long\nbook:\n  title: 健康书名\nhost: cc\n')
    makeBook('列表坏书', 'kind: long\n  孤儿子行\n')
    const r = await req({ method: 'GET', path: '/api/books' })
    expect(r.status).toBe(200)
    const books = r.json.books as Array<Record<string, unknown>>
    const healthy = books.find((b) => b['name'] === '列表健康书')!
    const damaged = books.find((b) => b['name'] === '列表坏书')!
    // 健康书：正常展开 + 无损坏标记（既有字段语义不变）
    expect(healthy['damaged']).toBeUndefined()
    expect(healthy['title']).toBe('健康书名')
    // 损坏书：显式标记，不再以默认骨架空 title 装作正常书（与单书端点 500 口径对齐）
    expect(damaged['damaged']).toBe(true)
    expect(damaged['title']).toBeUndefined()
    expect(damaged['path']).toBeTruthy() // 登记原样保留（可定位/可删）
  })
})

// ── ai-status 探测降级梯 ───────────────────────────────────

describe('kk-P2-15：ai-status 探测分支（非 mock 驱动）', () => {
  it('未配置 providers.json → available:false 未配置供应商', async () => {
    rmSync(join(userDataPath, 'providers.json'), { force: true })
    const r = await req({ method: 'GET', path: '/api/ai-status' })
    expect(r.status).toBe(200)
    expect(r.json.available).toBe(false)
    expect(r.json.reason).toContain('未配置')
  })

  it('当前供应商 caps:null → available:false 尚未测试连接', async () => {
    writeFileSync(
      join(userDataPath, 'providers.json'),
      JSON.stringify({
        currentId: 'p1',
        currentModel: 'm1',
        providers: [{ id: 'p1', name: '我的中转', protocol: 'anthropic', auth: 'bearer', baseUrl: 'http://x', apiKey: 'k', caps: null }],
      }),
    )
    const r = await req({ method: 'GET', path: '/api/ai-status' })
    expect(r.json.available).toBe(false)
    expect(r.json.driver).toBe('我的中转')
    expect(r.json.reason).toContain('尚未测试连接')
  })

  it('caps 已探测但无模型档位 → available:false 尚未配置模型档位', async () => {
    writeFileSync(
      join(userDataPath, 'providers.json'),
      JSON.stringify({
        currentId: 'p1',
        currentModel: '',
        providers: [{ id: 'p1', name: '我的中转', protocol: 'anthropic', auth: 'bearer', baseUrl: 'http://x', apiKey: 'k', caps: { connected: true, streaming: true } }],
      }),
    )
    const r = await req({ method: 'GET', path: '/api/ai-status' })
    expect(r.json.available).toBe(false)
    expect(r.json.reason).toContain('尚未配置模型档位')
  })

  it('供应商+caps+currentModel 齐 → available:true（正向对照）', async () => {
    writeFileSync(
      join(userDataPath, 'providers.json'),
      JSON.stringify({
        currentId: 'p1',
        currentModel: 'm1',
        providers: [{ id: 'p1', name: '我的中转', protocol: 'anthropic', auth: 'bearer', baseUrl: 'http://x', apiKey: 'k', caps: { connected: true, streaming: true } }],
      }),
    )
    const r = await req({ method: 'GET', path: '/api/ai-status' })
    expect(r.json.available).toBe(true)
    expect(r.json.driver).toBe('我的中转')
    expect(r.json.reason).toBeUndefined()
  })

  it('无 userDataPath（CLI 形态）→ available:false 未定位到应用数据目录', async () => {
    const r = await cliReq({ method: 'GET', path: '/api/ai-status' })
    expect(r.json.available).toBe(false)
    expect(r.json.reason).toContain('未定位到应用数据目录')
  })

  it('CLWRITING_E2E_AI_DOWN=1 → 短路最优先（覆盖 mock 之外的 e2e 分支）', async () => {
    process.env.CLWRITING_E2E_AI_DOWN = '1'
    try {
      const r = await req({ method: 'GET', path: '/api/ai-status' })
      expect(r.json.available).toBe(false)
      expect(r.json.reason).toContain('e2e')
      expect(r.json.driver).toBe('')
    } finally {
      delete process.env.CLWRITING_E2E_AI_DOWN
    }
  })
})
