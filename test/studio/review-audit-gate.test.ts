/**
 * hh-P1 持闸接线回归：三审运行闸与事件史清除闸纳入删书/改名检查。
 *
 * - 三审是分钟级长任务且无 abort 通道——此前 books 删/改名只查 self-heal/chat/spawn/
 *   task-gate，三审运行中放行会在旧路径重建孤儿目录并白烧 API 费用（与 spawn 闸同模式）；
 * - 事件史清除（DELETE /api/books/:name/audit）此前只挡 isChatRunning——task-gate 分钟级
 *   任务收尾会继续追加事件，运行中清库「清不彻底」。
 * 闸态经 __setReviewRunning / acquireTaskGate 测试钩子置位（不起真实三审，同 stream.ts 先例）；
 * 每例经 POST /api/books 自建自用书，互不依赖。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { __setReviewRunning } from '../../src/studio/server/api/review.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'

let workDir = ''
let userDataDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body ? JSON.stringify(body) : ''
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': token,
          origin: baseUrl,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
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
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-review-gate-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'clwriting-review-gate-ud-'))
  server = await startServerSafe({ port: 0, workDir, userDataPath: userDataDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

/** 经 API 建书（走脚手架，登记/active/目录一步到位） */
async function makeBook(name: string): Promise<void> {
  const r = await req('POST', '/api/books', { name, kind: 'long', genre: '玄幻' })
  expect(r.status).toBe(200)
}

describe('hh-P1: 三审闸纳入删书/改名持闸（409）', () => {
  it('三审运行中删书 → 409；释放后 → 200', async () => {
    const name = '三审闸删书测试'
    await makeBook(name)
    __setReviewRunning(name, true)
    const busy = await req('DELETE', `/api/books/${encodeURIComponent(name)}`)
    expect(busy.status).toBe(409)
    expect((busy.json as { error: string }).error).toContain('三审')
    __setReviewRunning(name, false)
    const ok = await req('DELETE', `/api/books/${encodeURIComponent(name)}`)
    expect(ok.status).toBe(200)
  })

  it('三审运行中改名 → 409；释放后 → 200', async () => {
    const name = '三审闸改名测试'
    await makeBook(name)
    __setReviewRunning(name, true)
    const busy = await req('POST', `/api/books/${encodeURIComponent(name)}/rename`, { name: '三审闸改名新名' })
    expect(busy.status).toBe(409)
    expect((busy.json as { error: string }).error).toContain('三审')
    __setReviewRunning(name, false)
    const ok = await req('POST', `/api/books/${encodeURIComponent(name)}/rename`, { name: '三审闸改名新名' })
    expect(ok.status).toBe(200)
  })
})

describe('hh-P1: 事件史清除补 task-gate 持闸（409）', () => {
  it('task-gate 持有中清事件史 → 409；释放后 → 200', async () => {
    const name = '清史闸测试书'
    await makeBook(name)
    const release = acquireTaskGate(name, 'rag-build')
    expect(release).not.toBeNull()
    const busy = await req('DELETE', `/api/books/${encodeURIComponent(name)}/audit`)
    expect(busy.status).toBe(409)
    expect((busy.json as { error: string }).error).toContain('rag-build')
    release!()
    const ok = await req('DELETE', `/api/books/${encodeURIComponent(name)}/audit`)
    expect(ok.status).toBe(200)
  })
})

describe('M-6（第十轮，回归第九轮 M-1）：三审闸纳入清空端点', () => {
  // 三审是分钟级长任务且无 abort 通道：在途清库/清空会「清不彻底」（任务收尾事件
  // 复活到已清 session）。闸态经 __setReviewRunning 测试钩子置位（不起真实三审）
  it('M-6（第十轮，回归第九轮 M-1）：audit 清空——三审在途 → 409 拒清；结束后 → 200 放行', async () => {
    const name = '三审闸审计清空书'
    await makeBook(name)
    __setReviewRunning(name, true)
    const busy = await req('DELETE', `/api/books/${encodeURIComponent(name)}/audit`)
    expect(busy.status).toBe(409)
    expect((busy.json as { error: string }).error).toContain('三审')
    __setReviewRunning(name, false)
    const ok = await req('DELETE', `/api/books/${encodeURIComponent(name)}/audit`)
    expect(ok.status).toBe(200)
  })

  it('M-6（第十轮，回归第九轮 M-1）：chat/clear 清空——三审在途 → 409 拒清；结束后 → 200 放行', async () => {
    const name = '三审闸对话清空书'
    await makeBook(name)
    __setReviewRunning(name, true)
    const busy = await req('POST', `/api/books/${encodeURIComponent(name)}/chat/clear`)
    expect(busy.status).toBe(409)
    expect((busy.json as { error: string }).error).toContain('三审')
    __setReviewRunning(name, false)
    const ok = await req('POST', `/api/books/${encodeURIComponent(name)}/chat/clear`)
    expect(ok.status).toBe(200)
  })
})
