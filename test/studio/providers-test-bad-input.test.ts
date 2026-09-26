/**
 * Z-9（五十八轮 Z 系列）回归：providers.test 畸形 JSON body → 400 BAD_INPUT
 * （不再被 catch-all 包成 500 GEN_FAIL）。
 *
 * 来源记档（2026-09-26 测试资产行为化批）：自批号目录 y2/z-head-regressions.test.ts
 * （Z 系列杂烩）按行为拆立；Z-1/Z-4 → rewrite-llm-call-meta、Z-12 →
 * degrade-attempts-chain。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

let baseUrl = ''
let server: http.Server | undefined
let token = ''
const workDir = mkdtempSync(join(tmpdir(), 'clw-z9-'))
const userDataPath = mkdtempSync(join(tmpdir(), 'clw-z9-ud-'))

beforeAll(async () => {
  server = await startServerSafe({ workDir, port: 0, userDataPath })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(() => {
  server?.close()
  try {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(userDataPath, { recursive: true, force: true })
  } catch {
    // Windows 清理竞态（句柄/防病毒占用偶发 EPERM）——best-effort 忽略
  }
})

describe('Z-9: providers.test 坏 JSON → 400', () => {
  it('畸形 JSON body → 400 BAD_INPUT（不再 500 GEN_FAIL）', async () => {
    const u = new URL(baseUrl)
    const r = await new Promise<{ status: number; text: string }>((resolve) => {
      const payload = '{not-json'
      const rr = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: `/api/providers/xxx/test`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.length),
            'x-studio-token': token,
          },
        },
        (res) => {
          let d = ''
          res.on('data', (c) => (d += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: d }))
        },
      )
      rr.on('error', () => resolve({ status: 0, text: '' }))
      rr.write(payload)
      rr.end()
    })
    expect(r.status).toBe(400)
    expect(r.text).toContain('BAD_INPUT')
  })
})
