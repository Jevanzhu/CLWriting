/**
 * providers API P4/P9/P10 集成测试（阶段 14 第二步）：
 * - revision：GET 返回递增计数；写端点带 stale expectedRevision → 409；不带 = 直通
 * - models：POST/PUT 模型行落盘（id/name/contextWindow/maxTokens）；models 变更不清 caps
 * - timeoutMs：PUT /api/tiers 档位超时（毫秒正整数）校验与回读
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

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
function req<T>(opts: ReqOpts): Promise<{ status: number; json: T }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: opts.path,
        method: opts.method,
        headers: {
          'x-studio-token': token,
          ...(opts.body !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(opts.body)) }
            : {}),
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
            /* 非 JSON 体 */
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

const CONF = {
  name: '测试供应商',
  protocol: 'openai',
  auth: 'bearer',
  baseUrl: 'https://example.local/v1',
  model: 'test-model',
  apiKey: 'sk-abcdef1234567890',
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-providers-p4-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-providers-p4-ud-'))
  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('P4 revision（乐观并发）', () => {
  it('GET 返回 revision；写操作递增；stale expectedRevision → 409', async () => {
    const g0 = await req<{ revision: number }>({ method: 'GET', path: '/api/providers' })
    expect(g0.status).toBe(200)
    expect(typeof g0.json.revision).toBe('number')
    const rev0 = g0.json.revision

    // 新增（不带 expectedRevision = 直通）→ revision +1
    const a = await req<{ provider: { id: string }; revision: number }>({
      method: 'POST',
      path: '/api/providers',
      body: CONF,
    })
    expect(a.status).toBe(200)
    expect(a.json.revision).toBe(rev0 + 1)
    const id = a.json.provider.id

    // 旧 revision 再写 → 409
    const stale = await req<{ error: string }>({
      method: 'PUT',
      path: `/api/providers/${id}`,
      body: { ...CONF, expectedRevision: rev0 },
    })
    expect(stale.status).toBe(409)
    expect(stale.json.error).toContain('刷新')

    // 新 revision 写 → 成功且再 +1
    const ok = await req<{ revision: number }>({
      method: 'PUT',
      path: `/api/providers/${id}`,
      body: { ...CONF, name: '改名', expectedRevision: rev0 + 1 },
    })
    expect(ok.status).toBe(200)
    expect(ok.json.revision).toBe(rev0 + 2)
  })

  it('DELETE 带 stale expectedRevision → 409（body best-effort 读取）', async () => {
    const a = await req<{ provider: { id: string }; revision: number }>({
      method: 'POST',
      path: '/api/providers',
      body: CONF,
    })
    expect(a.status).toBe(200)
    const g = await req<{ revision: number }>({ method: 'GET', path: '/api/providers' })
    const stale = await req<{ error: string }>({
      method: 'DELETE',
      path: `/api/providers/${a.json.provider.id}`,
      body: { expectedRevision: g.json.revision - 10 },
    })
    expect(stale.status).toBe(409)
    expect(stale.json.error).toContain('刷新')
    // 正确 revision 删除成功
    const del = await req<{ revision: number }>({
      method: 'DELETE',
      path: `/api/providers/${a.json.provider.id}`,
      body: { expectedRevision: g.json.revision },
    })
    expect(del.status).toBe(200)
    expect(typeof del.json.revision).toBe('number')
  })

  it('test / current 端点 bump revision 并回传——前端 test()/activate() 同步后可继续写（旧 stale-409 回归）', async () => {
    const a = await req<{ provider: { id: string }; revision: number }>({
      method: 'POST',
      path: '/api/providers',
      body: CONF,
    })
    expect(a.status).toBe(200)
    const id = a.json.provider.id

    // 探测写回 bump revision 且回传新值
    const t = await req<{ revision?: number; caps?: unknown }>({
      method: 'POST',
      path: `/api/providers/${id}/test`,
      body: { model: 'test-model' },
    })
    expect(t.status).toBe(200)
    // test 是 dry-run：探测成功写回 caps（saveProviders）→ revision 回传且递增
    expect(typeof t.json.revision).toBe('number')

    // 用测试回传的新 revision 再写 → 必须成功（不再 stale 409）
    const upd = await req<{ revision: number }>({
      method: 'PUT',
      path: `/api/providers/${id}`,
      body: { ...CONF, name: '测试后改名', expectedRevision: t.json.revision! },
    })
    expect(upd.status).toBe(200)

    // PUT /current saveProviders bump revision 且回传新值 → 后续仍可写
    const c = await req<{ revision: number; currentId: string | null }>({
      method: 'PUT',
      path: '/api/providers/current',
      body: { id, expectedRevision: upd.json.revision },
    })
    expect(c.status).toBe(200)
    expect(typeof c.json.revision).toBe('number')
    expect(c.json.revision).toBe(upd.json.revision + 1)
    const after = await req<{ revision: number }>({ method: 'PUT', path: `/api/providers/${id}`, body: { ...CONF, name: 'current 后改名', expectedRevision: c.json.revision } })
    expect(after.status).toBe(200)
  })
})

describe('P9 模型行', () => {
  it('POST/PUT 模型行落盘；PUT 只改 models 不清 caps', async () => {
    const a = await req<{ provider: { id: string } }>({
      method: 'POST',
      path: '/api/providers',
      body: {
        ...CONF,
        models: [
          { id: 'gpt-5', name: 'GPT-5', contextWindow: 400 * 1024, maxTokens: 128 * 1024 },
          { id: 'kimi-k2' },
        ],
      },
    })
    expect(a.status).toBe(200)
    const id = a.json.provider.id

    // 落盘可回读
    const g = await req<{ providers: { id: string; models?: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[] }[] }>({
      method: 'GET',
      path: '/api/providers',
    })
    const mine = g.json.providers.find((p) => p.id === id)
    expect(mine?.models).toEqual([
      { id: 'gpt-5', name: 'GPT-5', contextWindow: 400 * 1024, maxTokens: 128 * 1024 },
      { id: 'kimi-k2' },
    ])

    // 直写 caps 后只改 models → caps 保留（models 是 advisory，不触发字段变更清缓存）
    const sPath = join(userDataPath, 'providers.json')
    const s = JSON.parse(readFileSync(sPath, 'utf-8')) as { providers: { id: string; caps: unknown }[] }
    s.providers.find((p) => p.id === id)!.caps = { connected: true, streaming: true }
    writeFileSync(sPath, JSON.stringify(s))

    const upd = await req<{ provider: { models?: unknown[] } }>({
      method: 'PUT',
      path: `/api/providers/${id}`,
      body: { ...CONF, models: [{ id: 'only-one' }] },
    })
    expect(upd.status).toBe(200)
    expect(upd.json.provider.models).toEqual([{ id: 'only-one' }])
    const g2 = await req<{ providers: { id: string; caps: unknown }[] }>({ method: 'GET', path: '/api/providers' })
    expect(g2.json.providers.find((p) => p.id === id)?.caps).toMatchObject({ connected: true })
  })

  it('模型行 id 重复 / 空 id / 容量非正整数 → 400', async () => {
    const dup = await req<{ error: string }>({
      method: 'POST',
      path: '/api/providers',
      body: { ...CONF, models: [{ id: 'a' }, { id: 'a' }] },
    })
    expect(dup.status).toBe(400)
    expect(dup.json.error).toContain('唯一')

    const blank = await req<{ error: string }>({
      method: 'POST',
      path: '/api/providers',
      body: { ...CONF, models: [{ id: '  ' }] },
    })
    expect(blank.status).toBe(400)
    expect(blank.json.error).toContain('必填')

    const badCap = await req<{ error: string }>({
      method: 'POST',
      path: '/api/providers',
      body: { ...CONF, models: [{ id: 'a', contextWindow: -5 }] },
    })
    expect(badCap.status).toBe(400)
  })
})

describe('P10 档位超时 timeoutMs', () => {
  it('PUT /api/tiers 带 timeoutMs 落盘可回读；非正整数 → 400', async () => {
    const a = await req<{ provider: { id: string }; revision: number }>({
      method: 'POST',
      path: '/api/providers',
      body: CONF,
    })
    expect(a.status).toBe(200)
    const id = a.json.provider.id
    // 直写 caps 供档位引用的模型可达
    const sPath = join(userDataPath, 'providers.json')
    const s = JSON.parse(readFileSync(sPath, 'utf-8')) as { providers: { id: string; caps: unknown }[] }
    s.providers.find((p) => p.id === id)!.caps = { connected: true, streaming: true }
    writeFileSync(sPath, JSON.stringify(s))

    const put = await req<{ tiers: { creative: { timeoutMs?: number } } }>({
      method: 'PUT',
      path: '/api/tiers',
      body: {
        creative: { model: 'test-model', effort: 'xhigh', timeoutMs: 300000 },
        assistant: null,
        expectedRevision: a.json.revision,
      },
    })
    expect(put.status).toBe(200)
    expect(put.json.tiers.creative.timeoutMs).toBe(300000)

    const bad = await req<{ error: string }>({
      method: 'PUT',
      path: '/api/tiers',
      body: { creative: { model: 'test-model', effort: 'xhigh', timeoutMs: 0 } },
    })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toContain('timeoutMs')
  })
})