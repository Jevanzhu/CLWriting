/**
 * R35-30（三十五轮）回归：裸 /api 落 SPA 回 200 HTML → 404 JSON。
 *
 * apiPathname 判定用 startsWith('/api/')，不含精确 '/api'（无尾斜杠）——此前裸 /api
 * 一路落进静态分支回 200 index.html（API 前缀拿到 SPA 页面，D-4 同型问题的最后一档）。
 * 修复后任意大小写精确 '/api' 与 '/api/xxx' 未命中同回 404 JSON 信封；SPA 静态托管
 * 本身不回退（GET / 仍 200 HTML，证明 staticDir 真在托管——修复前本用例的 /api 断言
 * 拿到的就是它）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

let staticDir = ''
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function get(path: string): Promise<{ status: number; contentType: string; text: string }> {
  const r = await fetch(`${baseUrl}${path}`, { headers: { 'x-studio-token': token } })
  return { status: r.status, contentType: r.headers.get('content-type') ?? '', text: await r.text() }
}

beforeAll(async () => {
  staticDir = mkdtempSync(join(tmpdir(), 'clwriting-r35-api-spa-'))
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>SPA</title>', 'utf-8')
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r35-api-work-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  server = await startServerSafe({ port: 0, workDir, userDataPath: null, staticDir })
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (staticDir) rmSync(staticDir, { recursive: true, force: true })
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R35-30 裸 /api 不落 SPA', () => {
  it('GET /api → 404 JSON 信封（非 200 HTML）', async () => {
    const r = await get('/api')
    expect(r.status).toBe(404)
    expect(r.contentType).toContain('application/json')
    const body = JSON.parse(r.text) as { code: string; error: string }
    expect(body.code).toBe('NOT_FOUND')
  })

  it('GET /API → 同口径 404（大小写不敏感）', async () => {
    const r = await get('/API')
    expect(r.status).toBe(404)
    expect(r.contentType).toContain('application/json')
  })

  it('GET /api/xxx 未命中 → 既有 404 行为不变', async () => {
    for (const p of ['/api/nonexistent', '/api/nonexistent/deeper']) {
      const r = await get(p)
      expect(r.status).toBe(404)
      expect(r.contentType).toContain('application/json')
    }
  })

  it('SPA 静态托管不回退：GET / 仍 200 HTML（staticDir 真在托管）', async () => {
    const r = await get('/')
    expect(r.status).toBe(200)
    expect(r.contentType).toContain('text/html')
    expect(r.text).toContain('<title>SPA</title>')
  })
})
