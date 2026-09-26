/**
 * RAG（嵌入）服务商管理端点集成测（应用级多服务商，书按 rag.provider 引用）。
 *
 * 覆盖：CRUD 往返 / GET 脱敏（apiKey 空串 + masked）/ 落盘无明文 key（vault）/
 * 创建必填校验（含 http(s) 前缀）/ 编辑留空 key 保留 / endpoint 变更清 caps /
 * test 路由（embed 桩成功/失败翻转 caps）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServerSafe } from '../helpers/safe-port.js'

// 桩 embed：embedFails 翻转成功/失败（test 路由探测用）
let embedFails = false
vi.mock('../../src/rag/embed.js', () => ({
  embed: async () => (embedFails ? null : [[0.1, 0.2, 0.3]]),
}))

let userData = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function api(path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'x-studio-token': token, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }))
}

beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'clwriting-rag-prov-'))
  server = await startServerSafe({ port: 0, workDir: null, userDataPath: userData })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
  }
  if (userData) rmSync(userData, { recursive: true, force: true })
})

describe('RAG 服务商管理端点', () => {
  it('GET 初始：空列表', async () => {
    const r = await api('/api/rag-providers')
    expect(r.status).toBe(200)
    expect(r.json['ragProviders']).toEqual([])
  })

  it('POST 创建：四字段必填 + endpoint 须 http(s)', async () => {
    const noKey = await api('/api/rag-providers', {
      method: 'POST',
      body: JSON.stringify({ name: 'a', endpoint: 'https://e/x', model: 'm', apiKey: '' }),
    })
    expect(noKey.status).toBe(400)
    expect(String(noKey.json['error'])).toContain('apiKey 必填')

    const badUrl = await api('/api/rag-providers', {
      method: 'POST',
      body: JSON.stringify({ name: 'a', endpoint: 'ftp://e', model: 'm', apiKey: 'k' }),
    })
    expect(badUrl.status).toBe(400)
    expect(String(badUrl.json['error'])).toContain('http(s)')

    const ok = await api('/api/rag-providers', {
      method: 'POST',
      body: JSON.stringify({
        name: '测试嵌入',
        endpoint: 'https://stub.example/v1/embeddings',
        model: 'text-embedding-3-small',
        apiKey: 'sk-rag-test-123456',
      }),
    })
    expect(ok.status).toBe(200)
    const p = ok.json['provider'] as Record<string, unknown>
    expect(String(p['id']).startsWith('rag-')).toBe(true)
    // 脱敏：apiKey 空串 + 掩码回显
    expect(p['apiKey']).toBe('')
    expect(p['apiKeyMasked']).toBe('sk-r...3456')
    expect(p['caps']).toBeNull()
  })

  it('落盘无明文 key：providers.json 走 vault（H1 延伸——凭据不落明文）', async () => {
    const fp = join(userData, 'providers.json')
    expect(existsSync(fp)).toBe(true)
    const raw = readFileSync(fp, 'utf8')
    expect(raw).not.toContain('sk-rag-test-123456')
    const disk = JSON.parse(raw) as {
      ragProviders: Array<{ id: string; apiKey?: string }>
      vault: { keys: Record<string, unknown> }
    }
    expect(disk.ragProviders).toHaveLength(1)
    expect(disk.ragProviders[0]!.apiKey).toBeUndefined()
    expect(Object.keys(disk.vault.keys)).toHaveLength(1)
  })

  it('GET 列表回读（脱敏同上）；test 成功 → caps.connected=true', async () => {
    const list = await api('/api/rag-providers')
    expect(list.status).toBe(200)
    const arr = list.json['ragProviders'] as Array<Record<string, unknown>>
    expect(arr).toHaveLength(1)
    const id = String(arr[0]!['id'])

    embedFails = false
    const t = await api(`/api/rag-providers/${encodeURIComponent(id)}/test`, { method: 'POST' })
    expect(t.status).toBe(200)
    expect(t.json).toMatchObject({ ok: true, caps: { connected: true } })

    // 列表回读 caps 已落库
    const after = await api('/api/rag-providers')
    expect((after.json['ragProviders'] as Array<Record<string, unknown>>)[0]!['caps']).toMatchObject({
      connected: true,
    })
  })

  it('test 失败 → caps.connected=false（embed 桩翻转）', async () => {
    const list = await api('/api/rag-providers')
    const id = String((list.json['ragProviders'] as Array<Record<string, unknown>>)[0]!['id'])
    embedFails = true
    const t = await api(`/api/rag-providers/${encodeURIComponent(id)}/test`, { method: 'POST' })
    expect(t.status).toBe(200)
    expect(t.json).toMatchObject({ ok: false })
    expect(String(t.json['error'])).toContain('嵌入端点调用失败')
    embedFails = false
  })

  it('PUT 编辑：apiKey 留空 = 保留原 key（同主机）；endpoint 变更 → caps 清空', async () => {
    const list = await api('/api/rag-providers')
    const id = String((list.json['ragProviders'] as Array<Record<string, unknown>>)[0]!['id'])

    // 先把 caps 置回 connected（上例翻转成 false 了）
    await api(`/api/rag-providers/${encodeURIComponent(id)}/test`, { method: 'POST' })

    // 只改名（endpoint/model 不变，key 空）→ caps 保留
    const keep = await api(`/api/rag-providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: '改名',
        endpoint: 'https://stub.example/v1/embeddings',
        model: 'text-embedding-3-small',
        apiKey: '',
      }),
    })
    expect(keep.status).toBe(200)
    expect((keep.json['provider'] as Record<string, unknown>)['caps']).toMatchObject({ connected: true })
    // key 仍有效：落盘仍无明文 + 掩码不变（原 key 未被空串覆盖）
    const afterKeep = await api('/api/rag-providers')
    expect((afterKeep.json['ragProviders'] as Array<Record<string, unknown>>)[0]!['apiKeyMasked']).toBe('sk-r...3456')

    // 换 endpoint（同主机换路径，RC 源码重审 B-4 补洞后：同主机才允许留空 key）→ caps 清空（要求重测）
    const change = await api(`/api/rag-providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: '改名',
        endpoint: 'https://stub.example/v2/embeddings',
        model: 'text-embedding-3-small',
        apiKey: '',
      }),
    })
    expect(change.status).toBe(200)
    expect((change.json['provider'] as Record<string, unknown>)['caps']).toBeNull()
  })

  // RC 源码重审 B-4 同型补洞（复核遗留项）：/api/rag-providers 与 /api/providers 同一段
  // 「留空 Key = 不改」语义、另一份拷贝——endpoint 换主机时沿用旧 Key 即把已存凭据发往
  // 新地址（下一次嵌入往返就送达）。判定与文案单源见 api/host-change-guard.ts。
  it('RC-B-4：endpoint 换主机 + Key 留空 → 400 拒绝且盘上零改写；同请求带 Key 才放行', async () => {
    const before = (await api('/api/rag-providers')).json['ragProviders'] as Array<Record<string, unknown>>
    const id = String(before[0]!['id'])
    const disk0 = readFileSync(join(userData, 'providers.json'), 'utf8')

    // 换主机（stub.example → evil.example）+ 空 Key → 拒（不静默沿用旧 Key 外流）
    const blocked = await api(`/api/rag-providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: '迁站',
        endpoint: 'https://evil.example/v1/embeddings',
        model: 'text-embedding-3-small',
        apiKey: '',
      }),
    })
    expect(blocked.status).toBe(400)
    expect(blocked.json['code']).toBe('API_KEY_REQUIRED_ON_HOST_CHANGE')
    expect(String(blocked.json['error'])).toContain('主机已变更')
    // 盘上零改写（endpoint 与掩码都还是原值；失败路径不得留下半改状态）
    const after = (await api('/api/rag-providers')).json['ragProviders'] as Array<Record<string, unknown>>
    expect(after[0]!['endpoint']).toBe('https://stub.example/v2/embeddings')
    expect(after[0]!['apiKeyMasked']).toBe('sk-r...3456')
    expect(readFileSync(join(userData, 'providers.json'), 'utf8')).toBe(disk0)

    // 同请求显式带 Key → 正常放行（作者改主机的正路）
    const ok = await api(`/api/rag-providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: '迁站',
        endpoint: 'https://evil.example/v1/embeddings',
        model: 'text-embedding-3-small',
        apiKey: 'sk-new-host-987654',
      }),
    })
    expect(ok.status).toBe(200)
    const afterOk = (await api('/api/rag-providers')).json['ragProviders'] as Array<Record<string, unknown>>
    expect(afterOk[0]!['endpoint']).toBe('https://evil.example/v1/embeddings')
    expect(afterOk[0]!['apiKeyMasked']).toBe('sk-n...7654')

    // 复原：换回原主机 + 重填原 key（后续用例共用同一服务商）
    const restore = await api(`/api/rag-providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: '测试嵌入',
        endpoint: 'https://stub.example/v1/embeddings',
        model: 'text-embedding-3-small',
        apiKey: 'sk-rag-test-123456',
      }),
    })
    expect(restore.status).toBe(200)
    expect(readFileSync(join(userData, 'providers.json'), 'utf8')).not.toContain('sk-rag-test-123456')
  })

  it('PUT / DELETE 不存在的 id → 404', async () => {
    const put = await api('/api/rag-providers/rag-none', {
      method: 'PUT',
      body: JSON.stringify({ name: 'x', endpoint: 'https://e', model: 'm', apiKey: '' }),
    })
    expect(put.status).toBe(404)
    const del = await api('/api/rag-providers/rag-none', { method: 'DELETE' })
    expect(del.status).toBe(404)
    const test = await api('/api/rag-providers/rag-none/test', { method: 'POST' })
    expect(test.status).toBe(404)
  })

  it('DELETE 删除 → 列表空 + vault 槽清（D4 同 chat 服务商语义）', async () => {
    const list = await api('/api/rag-providers')
    const id = String((list.json['ragProviders'] as Array<Record<string, unknown>>)[0]!['id'])
    const del = await api(`/api/rag-providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    expect(del.status).toBe(200)

    const after = await api('/api/rag-providers')
    expect(after.json['ragProviders']).toEqual([])

    const disk = JSON.parse(readFileSync(join(userData, 'providers.json'), 'utf8')) as {
      ragProviders: unknown[]
      vault: { keys: Record<string, unknown> }
    }
    expect(disk.ragProviders).toEqual([])
    expect(Object.keys(disk.vault.keys)).toHaveLength(0)
  })
})

describe('RAG 服务商 API Key 单点 + hasKey 状态点（I6·dsh）', () => {
  it('POST charset 外 key（含空格/非 ASCII）→ 400 且文案不回显 key 本体', async () => {
    for (const bad of ['sk-rag 密钥', 'sk-rag\nkey']) {
      const r = await api('/api/rag-providers', {
        method: 'POST',
        body: JSON.stringify({ name: '坏key嵌入', endpoint: 'https://e/x', model: 'm', apiKey: bad }),
      })
      expect(r.status).toBe(400)
      expect(String(r.json['error'])).toContain('无法传输的字符')
      expect(String(r.json['error'])).not.toContain(bad.trim())
    }
  })

  it('POST 合法 key（首尾空白 trim）→ hasKey=true；GET 列表同 vault 推导', async () => {
    const ok = await api('/api/rag-providers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'I6嵌入',
        endpoint: 'https://stub.example/v1/embeddings',
        model: 'm2',
        apiKey: '  sk-rag-i6-123456  ',
      }),
    })
    expect(ok.status).toBe(200)
    expect((ok.json['provider'] as Record<string, unknown>)['hasKey']).toBe(true)

    const list = await api('/api/rag-providers')
    const arr = list.json['ragProviders'] as Array<Record<string, unknown>>
    expect(arr.find((p) => p['name'] === 'I6嵌入')!['hasKey']).toBe(true)
  })
})
