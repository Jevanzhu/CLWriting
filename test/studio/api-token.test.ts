/**
 * P0 session token 测(GPT-5 P0 defense-in-depth):写端点 token 校验。
 *
 * /api/boot 注入 token;写端点(POST/PUT/DELETE)无 token / 错 token → 403;对 token 放行进 dispatch。
 * 与 CORS Origin 校验叠加(双重防跨站)。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

let baseUrl = ''
let server: http.Server | undefined
let token = ''

function rawRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = '',
): Promise<{ status: number }> {
  return new Promise((resolve) => {
    const u = new URL(baseUrl)
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
    })
    req.on('error', () => resolve({ status: 0 }))
    if (body) req.write(body)
    req.end()
  })
}

beforeAll(async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'clwriting-token-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), '')
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  const d = (await r.json()) as { token: string }
  token = d.token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
})

describe('P0 session token(写端点 defense-in-depth)', () => {
  it('GET /api/boot 返非空 token', () => {
    expect(token).toBeTruthy()
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
    expect(r.status).not.toBe(403) // 过 token 门后 dispatch 处理(书不存在 → 4xx,但非 403)
  })

  it('GET 无 token → 200(token 只校验写端点)', async () => {
    const r = await rawRequest('GET', '/api/books', {})
    expect(r.status).toBe(200)
  })

  it('POST 超过 JSON body 上限 → 413', async () => {
    const body = JSON.stringify({ sourcePath: 'x'.repeat(1024 * 1024 + 1) })
    const r = await rawRequest(
      'POST',
      '/api/import',
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
