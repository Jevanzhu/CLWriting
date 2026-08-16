/**
 * /api/providers 端点集成测试（P0-1 修复后的回归保护）。
 *
 * 核心回归：PUT /api/providers/current 必须先于 PUT /:id 注册，
 * 否则被参数路由遮蔽 → 恒 404「供应商不存在」，多供应商切换功能全废。
 *
 * 全部端点不涉真网络（test 端点只测不存在 id 的 404 分支）。
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
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
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
            /* 非 JSON（如 501 空体） */
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

interface ProviderDto {
  id: string
  name: string
  protocol: string
  baseUrl: string
  model: string
  apiKey: string
  apiKeyMasked: string
  caps: unknown
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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-providers-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-providers-ud-'))
  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('/api/providers（P0-1 修复后回归）', () => {
  it('PUT /current 不被 /:id 遮蔽——先加两个供应商再切换', async () => {
    const a = await req<{ provider: ProviderDto }>({ method: 'POST', path: '/api/providers', body: CONF })
    expect(a.status).toBe(200)
    const pa = a.json.provider
    expect(pa.apiKey).toBe('')
    expect(pa.apiKeyMasked).toContain('sk-')

    const b = await req<{ provider: ProviderDto }>({
      method: 'POST',
      path: '/api/providers',
      body: { ...CONF, name: '第二个', model: 'other-model' },
    })
    expect(b.status).toBe(200)
    const pb = b.json.provider

    // P2-6：未探测不许启用——b 的 caps=null → 400（也验证路由命中正确：遮蔽会是 404）
    const sw1 = await req<{ error: string }>({
      method: 'PUT',
      path: '/api/providers/current',
      body: { id: pb.id },
    })
    expect(sw1.status).toBe(400)
    expect(sw1.json.error).toContain('测试连接')

    // 模拟已探测：直接写 caps 到 providers.json（pa + pb 都写，DELETE 回落也需要 caps）
    const sPath = join(userDataPath, 'providers.json')
    const s = JSON.parse(readFileSync(sPath, 'utf-8')) as { providers: { id: string; caps: unknown }[] }
    s.providers.find((p) => p.id === pb.id)!.caps = { connected: true, streaming: true }
    s.providers.find((p) => p.id === pa.id)!.caps = { connected: true, streaming: true }
    writeFileSync(sPath, JSON.stringify(s))

    // 关键断言：已探测后切换命中字面量路由而非 :id（P0-1 回归）
    const sw = await req<{ ok: boolean; currentId: string }>({
      method: 'PUT',
      path: '/api/providers/current',
      body: { id: pb.id },
    })
    expect(sw.status).toBe(200)
    expect(sw.json.ok).toBe(true)
    expect(sw.json.currentId).toBe(pb.id)

    // 列表应反映 currentId
    const list = await req<{ providers: ProviderDto[]; currentId: string | null }>({
      method: 'GET',
      path: '/api/providers',
    })
    expect(list.status).toBe(200)
    expect(list.json.providers).toHaveLength(2)
    expect(list.json.currentId).toBe(pb.id)

    // 编辑：PUT /:id 仍正常（不被 current 反遮蔽——正则要求单段）
    const ed = await req<{ provider: ProviderDto }>({
      method: 'PUT',
      path: `/api/providers/${pb.id}`,
      body: { ...CONF, name: '改名后', model: 'other-model' },
    })
    expect(ed.status).toBe(200)
    expect(ed.json.provider.name).toBe('改名后')

    // 删除 current：回落第一个
    const del = await req<{ ok: boolean; currentId: string | null }>({
      method: 'DELETE',
      path: `/api/providers/${pb.id}`,
    })
    expect(del.status).toBe(200)
    expect(del.json.currentId).toBe(pa.id)
  })

  it('PUT /current 引用不存在的 id → 404', async () => {
    const r = await req<{ error: string }>({
      method: 'PUT',
      path: '/api/providers/current',
      body: { id: 'prov-not-exist' },
    })
    expect(r.status).toBe(404)
    expect(r.json.error).toContain('供应商不存在')
  })

  it('POST 缺少 apiKey → 400（D10：新增时必填）', async () => {
    const r = await req<{ error: string }>({
      method: 'POST',
      path: '/api/providers',
      body: { ...CONF, apiKey: '' },
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('apiKey 必填')
  })

  it('POST openai-responses 协议 → 400 拒配（Z-P2-1：已停用，提示改用 openai）', async () => {
    const r = await req<{ error: string }>({
      method: 'POST',
      path: '/api/providers',
      body: { ...CONF, protocol: 'openai-responses' },
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('openai-responses 协议已停用')
    expect(r.json.error).toContain('openai')
  })

  it('PUT 编辑为 openai-responses 协议 → 同样拒配 400', async () => {
    const a = await req<{ provider: ProviderDto }>({ method: 'POST', path: '/api/providers', body: CONF })
    const pid = a.json.provider.id
    const r = await req<{ error: string }>({
      method: 'PUT',
      path: `/api/providers/${pid}`,
      body: { ...CONF, protocol: 'openai-responses' },
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('已停用')
  })

  it('POST /:id/test 对不存在的 id → 404（不涉真网络）', async () => {
    const r = await req<{ error: string }>({
      method: 'POST',
      path: '/api/providers/prov-not-exist/test',
    })
    expect(r.status).toBe(404)
    expect(r.json.error).toContain('供应商不存在')
  })
})

describe('P0-3 structured 降级记忆失效', () => {
  it('编辑供应商关键字段后清降级记忆', async () => {
    const a = await req<{ provider: ProviderDto }>({ method: 'POST', path: '/api/providers', body: CONF })
    const pid = a.json.provider.id

    // 手动写入降级记忆（structured 不支持）
    const sPath = join(userDataPath, 'providers.json')
    const s = JSON.parse(readFileSync(sPath, 'utf-8')) as { modelCaps: Record<string, unknown> }
    s.modelCaps = { [`${pid}/test-model`]: { structured: false } }
    writeFileSync(sPath, JSON.stringify(s))

    // 编辑（改变 baseUrl → fieldsChanged=true）
    const ed = await req<{ provider: ProviderDto }>({
      method: 'PUT',
      path: `/api/providers/${pid}`,
      body: { ...CONF, baseUrl: 'https://changed.local/v1' },
    })
    expect(ed.status).toBe(200)

    const after = JSON.parse(readFileSync(sPath, 'utf-8')) as { modelCaps: Record<string, unknown> }
    expect(after.modelCaps[`${pid}/test-model`]).toBeUndefined()
  })

  it('删除供应商时清降级记忆', async () => {
    const a = await req<{ provider: ProviderDto }>({ method: 'POST', path: '/api/providers', body: CONF })
    const pid = a.json.provider.id

    const sPath = join(userDataPath, 'providers.json')
    const s = JSON.parse(readFileSync(sPath, 'utf-8')) as { modelCaps: Record<string, unknown> }
    s.modelCaps = { [`${pid}/test-model`]: { structured: false } }
    writeFileSync(sPath, JSON.stringify(s))

    const del = await req<{ ok: boolean }>({ method: 'DELETE', path: `/api/providers/${pid}` })
    expect(del.status).toBe(200)

    const after = JSON.parse(readFileSync(sPath, 'utf-8')) as { modelCaps: Record<string, unknown> }
    expect(after.modelCaps[`${pid}/test-model`]).toBeUndefined()
  })
})