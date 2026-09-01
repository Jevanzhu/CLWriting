/**
 * G4-a + G6：AI 可达性探测端点 + editor 端点不受 AI 可达影响。
 * CLWRITING_DRIVER=mock → available:true；连续请求一致（P0-2 起无缓存，每次实时重算）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let prevDriver: string | undefined

function get(path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { 'x-studio-token': token } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  prevDriver = process.env.CLWRITING_DRIVER
  process.env.CLWRITING_DRIVER = 'mock' // mock 永可达（不依赖本机 claude CLI）
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-aistatus-'))
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (prevDriver === undefined) delete process.env.CLWRITING_DRIVER
  else process.env.CLWRITING_DRIVER = prevDriver
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('G4-a：GET /api/ai-status（mock 模式）', () => {
  it('mock 驱动 → available:true', async () => {
    const r = await get('/api/ai-status')
    expect(r.status).toBe(200)
    const j = r.json as { available: boolean }
    expect(j.available).toBe(true)
  })

  it('连续请求一致（无缓存，结果稳定）', async () => {
    const r1 = await get('/api/ai-status')
    const r2 = await get('/api/ai-status')
    const j1 = r1.json as { available: boolean }
    const j2 = r2.json as { available: boolean }
    expect(j1.available).toBe(j2.available)
  })
})

describe('G6：editor 组端点不依赖 AI 可达性', () => {
  it('books 列表 200（editor 组全局端点，无 driver）', async () => {
    const r = await get('/api/books')
    expect(r.status).toBe(200)
  })
})
