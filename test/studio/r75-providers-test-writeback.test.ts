/**
 * R75-D-P3c（批 D）回归：providers test 端点探测窗内配置被改 → 旧快照 caps 不回写。
 *
 * 探测是 10s+ 网络往返；窗口内 PUT 编辑供应商（改 baseUrl 会清 caps 要求重新探测）后，
 * 旧快照的 caps 回写会把「打旧端点探出的能力」盖到新配置上，绕过「编辑清 caps」
 * 不变量。修复：回写前按探测相关字段指纹（protocol/auth/baseUrl/apiKey，与 PUT 的
 * fieldsChanged 同源）复检，变了就丢弃回写并留痕（revision 不 bump）。
 *
 * 探测窗竞态用注入探测函数开出（mock driver 快路探测瞬时完成，开不出真实窗口）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { __setProbeCapabilitiesForTest } from '../../src/studio/server/api/providers.js'
import type { ProbeResult, ProviderConf } from '../../src/ai/provider/index.js'

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
          origin: baseUrl,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          let json: T = null as T
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON */
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
  caps: { connected: boolean; streaming: boolean } | null
}

const CONF = {
  name: '探测窗供应商',
  protocol: 'openai',
  auth: 'bearer',
  baseUrl: 'https://example.local/v1',
  apiKey: 'sk-abcdef1234567890',
}

const FAKE_CAPS: ProbeResult = { caps: { connected: true, streaming: true }, details: ['注入探测'] }

/** 受控探测：被调用即点亮 started；结果等待 release 注入（开出确定性探测窗）。 */
function controlledProbe(): {
  started: Promise<void>
  finish: (r: ProbeResult) => void
  probe: (conf: ProviderConf) => Promise<ProbeResult>
} {
  let resolveStart!: () => void
  let resolveResult!: (r: ProbeResult) => void
  return {
    started: new Promise<void>((r) => (resolveStart = r)),
    finish: (r) => resolveResult(r),
    probe: () => {
      resolveStart()
      return new Promise<ProbeResult>((resolve) => (resolveResult = resolve))
    },
  }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r75-probe-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-r75-probe-ud-'))
  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  __setProbeCapabilitiesForTest(null) // 恢复真探测，防注入泄漏到同进程其它用例
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('R75-D-P3c：test 端点探测窗配置变更 → 丢弃 caps 回写', () => {
  it('探测期间改 baseUrl → caps 不回写、revision 不 bump', async () => {
    const a = await req<{ provider: ProviderDto }>({ method: 'POST', path: '/api/providers', body: CONF })
    expect(a.status).toBe(200)
    const pid = a.json.provider.id

    const ctl = controlledProbe()
    __setProbeCapabilitiesForTest(ctl.probe)
    // 发起 test（不 await——探测窗挂起期间改配置）
    const testReq = req<{ ok: boolean; caps: unknown; revision: number }>({
      method: 'POST',
      path: `/api/providers/${pid}/test`,
    })
    await ctl.started // handler 已过 snapshot 载入，悬挂在探测窗内

    // 探测窗内编辑：baseUrl 变（PUT 会清 caps 要求重新探测——指纹应失配）
    const put = await req<{ provider: ProviderDto; revision: number }>({
      method: 'PUT',
      path: `/api/providers/${pid}`,
      body: { ...CONF, baseUrl: 'https://changed.local/v1' },
    })
    expect(put.status).toBe(200)
    const putRevision = put.json.revision

    ctl.finish(FAKE_CAPS) // 探测完成（打的是旧 baseUrl）
    const t = await testReq
    expect(t.status).toBe(200)
    expect(t.json.ok).toBe(true)
    expect((t.json.caps as { connected: boolean }).connected).toBe(true) // 结果仍回传发起者
    expect(t.json.revision).toBe(putRevision) // 未落盘 → revision 不因回写 bump

    // 旧快照 caps 不回写：列表里该供应商 caps 仍为 null（等作者按新配置重新探测）
    const list = await req<{ providers: ProviderDto[]; revision: number }>({ method: 'GET', path: '/api/providers' })
    const after = list.json.providers.find((p) => p.id === pid)!
    expect(after.caps).toBeNull()
    expect(list.json.revision).toBe(putRevision)
  })

  it('探测期间只改无关字段（name）→ 指纹不失配，回写照常', async () => {
    const a = await req<{ provider: ProviderDto }>({ method: 'POST', path: '/api/providers', body: CONF })
    const pid = a.json.provider.id

    const ctl = controlledProbe()
    __setProbeCapabilitiesForTest(ctl.probe)
    const testReq = req<{ ok: boolean }>({ method: 'POST', path: `/api/providers/${pid}/test` })
    await ctl.started

    const put = await req<{ provider: ProviderDto }>({
      method: 'PUT',
      path: `/api/providers/${pid}`,
      body: { ...CONF, name: '只改名', apiKey: '' }, // apiKey 空 = 保留原 key → 四字段指纹不变
    })
    expect(put.status).toBe(200)

    ctl.finish(FAKE_CAPS)
    const t = await testReq
    expect(t.status).toBe(200)

    const list = await req<{ providers: ProviderDto[] }>({ method: 'GET', path: '/api/providers' })
    const after = list.json.providers.find((p) => p.id === pid)!
    expect(after.caps).toEqual({ connected: true, streaming: true }) // 回写照常
  })

  it('探测期间配置未变 → caps 正常回写（无回归）', async () => {
    __setProbeCapabilitiesForTest(async () => FAKE_CAPS) // 即时探测
    const a = await req<{ provider: ProviderDto }>({ method: 'POST', path: '/api/providers', body: CONF })
    const pid = a.json.provider.id

    const t = await req<{ ok: boolean; revision: number }>({ method: 'POST', path: `/api/providers/${pid}/test` })
    expect(t.status).toBe(200)

    const list = await req<{ providers: ProviderDto[]; revision: number }>({ method: 'GET', path: '/api/providers' })
    const after = list.json.providers.find((p) => p.id === pid)!
    expect(after.caps).toEqual({ connected: true, streaming: true })
    expect(list.json.revision).toBe(t.json.revision) // 回写 bump 后的 revision 一致可见
  })
})
