/**
 * R29-2（二十九轮）回归：providers 保存端点的写入失败接线（端点侧）。
 *
 * 批 B 把 store.ts 的 saveProviders 从 void 改为 Promise<void>（排队段写失败向上
 * 传播）。端点侧保存点统一 try/await 捕住 → 500 WRITE_ERROR 信封（此前排队段失败
 * 被 log.warn 吞掉 → 200 假成功，作者以为已保存）。当前 void 返回下 await/try-catch
 * 零行为差异——本测试以「saveProviders reject / resolve 双态桩」两端都锁：
 * - reject → 500 { code:'WRITE_ERROR', error:'配置写入失败，请重试' }（providers 与
 *   rag-providers 两组端点同口径）；
 * - resolve → 200 正常出口（不误伤）。
 * PUT 前置数据以真实 saveProviders（__realSaveProviders）落盘——桩 save 不写盘，
 * 内存态编辑对下一次 loadProviders 不可见。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServerSafe } from '../helpers/safe-port.js'
import * as providerIndex from '../../src/ai/provider/index.js'

// saveProviders 桩（双态可控）；loadProviders 等其余导出保持真实现。
// __realSaveProviders：真实落盘版（仅测试播种用，生产无此导出）。
vi.mock('../../src/ai/provider/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/provider/index.js')>()
  return { ...orig, saveProviders: vi.fn(() => {}), __realSaveProviders: orig.saveProviders }
})

const realSaveProviders = (providerIndex as unknown as {
  __realSaveProviders: typeof providerIndex.saveProviders
}).__realSaveProviders

// saveProviders 原签名为 void 返回，批 B 落地后才变 Promise<void>——桩控制面按宽类型取用
const saveMock = providerIndex.saveProviders as unknown as {
  mockReset(): unknown
  mockResolvedValueOnce(value: void): unknown
  mockRejectedValueOnce(reason: unknown): unknown
}

let userData = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body === undefined ? '' : JSON.stringify(body)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': token,
          origin: baseUrl,
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }))
      },
    )
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

/** 用真实 saveProviders 落盘播种一条 RAG 提供方（桩 save 不写盘，PUT 需盘上真数据）。 */
function seedRagProvider(id: string): void {
  const s = providerIndex.loadProviders(userData)
  s.ragProviders.push({
    id,
    name: '种子嵌入',
    endpoint: 'https://embed.example.com/v1',
    model: 'embed-model',
    apiKey: 'sk-seed-key-1234567890',
    caps: null,
    sortIndex: 0,
  })
  realSaveProviders(userData, s)
}

beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'clw-r29-prov-write-'))
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

const PROVIDER_BODY = {
  name: '测试供应商',
  protocol: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-1234567890',
}
const RAG_PROVIDER_BODY = {
  name: '测试嵌入',
  endpoint: 'https://embed.example.com/v1',
  model: 'embed-model',
  apiKey: 'sk-embed-1234567890',
}

describe('R29-2：providers 保存端点写入失败 500 信封', () => {
  it('POST /api/providers：saveProviders reject → 500 WRITE_ERROR（不再 200 假成功）', async () => {
    saveMock.mockReset()
    saveMock.mockRejectedValueOnce(new Error('EACCES: providers.json 写入失败'))
    const r = await req('POST', '/api/providers', PROVIDER_BODY)
    expect(r.status).toBe(500)
    expect(r.json).toEqual({ code: 'WRITE_ERROR', error: '配置写入失败，请重试' })
  })

  it('PUT /api/rag-providers/:id：reject → 同口径 500（写盘前可见的盘上真数据）', async () => {
    saveMock.mockReset()
    seedRagProvider('rag-r29-putcase')
    saveMock.mockRejectedValueOnce(new Error('磁盘满'))
    const put = await req('PUT', '/api/rag-providers/rag-r29-putcase', {
      name: '改名失败',
      endpoint: 'https://embed.example.com/v1',
      model: 'embed-model',
      apiKey: '',
    })
    expect(put.status).toBe(500)
    expect(put.json).toEqual({ code: 'WRITE_ERROR', error: '配置写入失败，请重试' })
  })

  it('POST /api/rag-providers：reject → 同口径 500', async () => {
    saveMock.mockReset()
    saveMock.mockRejectedValueOnce(new Error('磁盘满'))
    const r = await req('POST', '/api/rag-providers', RAG_PROVIDER_BODY)
    expect(r.status).toBe(500)
    expect(r.json).toEqual({ code: 'WRITE_ERROR', error: '配置写入失败，请重试' })
  })

  it('saveProviders 正常 resolve → 200 出口不变（void 语义零行为差异）', async () => {
    saveMock.mockReset()
    saveMock.mockResolvedValueOnce(undefined)
    const r = await req('POST', '/api/providers', PROVIDER_BODY)
    expect(r.status).toBe(200)
    expect((r.json['provider'] as { apiKeyMasked: string }).apiKeyMasked.length).toBeGreaterThan(0)
  })
})
