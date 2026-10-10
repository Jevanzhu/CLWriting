/**
 * 诊断包端点（POST /api/diagnostics）回归：
 * - 有 userDataPath → 200 域形状（file/dir/entries/bytes），盘上确有包；
 * - 无 userDataPath → 422 DIAGNOSTICS_FAILED 错误信封（业务失败不穿 500 兜底）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServerSafe } from '../../helpers/safe-port.js'

let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function req(url: string, tok: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'x-studio-token': tok,
      origin: url,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 留 null */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-diag-api-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-diag-api-ud-'))
  mkdirSync(join(userDataPath, 'logs'), { recursive: true })
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), '')
  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  rmSync(workDir, { recursive: true, force: true })
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('POST /api/diagnostics', () => {
  it('有 userDataPath → 200：回包路径/条目清单，盘上确有该 ZIP', async () => {
    const r = await req(baseUrl, token, '/api/diagnostics')
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; file?: string; dir?: string; entries?: string[]; bytes?: number }
    expect(body.ok).toBe(true)
    expect(body.entries?.[0]).toBe('说明.txt')
    expect(body.file?.endsWith('.zip')).toBe(true)
    expect(body.dir).toBe(join(userDataPath, '诊断包'))
    expect(existsSync(body.file!)).toBe(true)
    expect(body.bytes ?? 0).toBeGreaterThan(0)
  })

  it('无 userDataPath → 422 DIAGNOSTICS_FAILED 错误信封（业务失败不穿 500）', async () => {
    // 另起一实例（不传 userDataPath）：与本文件主实例隔离，验未定位应用数据目录的失败面
    const bare = await startServerSafe({ port: 0, workDir })
    const bareUrl = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`
    try {
      const boot = await fetch(`${bareUrl}/api/boot`)
      const bareTok = ((await boot.json()) as { token: string }).token
      const r = await req(bareUrl, bareTok, '/api/diagnostics')
      expect(r.status).toBe(422)
      const body = r.json as { code: string; error: string }
      expect(body.code).toBe('DIAGNOSTICS_FAILED')
      expect(body.error).toContain('应用数据目录')
    } finally {
      await new Promise<void>((r) => bare.close(() => r()))
    }
  })
})
