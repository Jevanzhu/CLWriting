/**
 * AI-1（第七轮）回归：编排互斥矩阵补全——/auto-write 与 /spawn 补 isChatRunning 反向闸。
 *
 * 修复背景：M-1（第六轮）只修了 chat→self-heal 单向（chat 侧嵌套生成工具闸
 * isSelfHealRunning）；反向缺口完整：chat 在途（含 rewrite/write_chapter 按章记账的
 * 嵌套生成）时可并发启动 self-heal / spawn——两路 runTask 以不同章号交替调
 * recordAiCall 互覆预算章块（预算闸被绕过），且后到的 ctrl register 触发 driver
 * 「换新先 abort 旧」把在途对话静默掐断。
 * 本测试锁三件事：
 * 1. chat 在途 → POST /spawn 409（不进 readJson、不占 spawnRunning）；
 * 2. chat 在途 → POST /auto-write 409（首闸即拦）；
 * 3. chat 空闲 → 两路由越过 chat 闸（spawn 落到 prompt 校验 400、auto-write 落到
 *    chapter 校验 400——证明闸不误伤且未实际启动编排）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { isChatRunning } from '../../src/ai/orchestrate/chat.js'
import { isSelfHealRunning } from '../../src/ai/orchestrate/self-heal.js'

vi.mock('../../src/ai/orchestrate/chat.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/orchestrate/chat.js')>()
  return { ...orig, isChatRunning: vi.fn(() => false) }
})
vi.mock('../../src/ai/orchestrate/self-heal.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/orchestrate/self-heal.js')>()
  return { ...orig, isSelfHealRunning: vi.fn(() => false) }
})

const BOOK = '互斥闸书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-orch-mutex-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-orch-mutex-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 互斥闸书\n  genre: 玄幻\nhost: cc\n',
  )
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

function post(path: string, body?: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: {
          origin: baseUrl,
          'x-studio-token': token,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 留 null */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

describe('AI-1: 编排互斥矩阵反向闸', () => {
  it('chat 在途 → /spawn 409，不进 prompt 校验（闸先于 readJson）', async () => {
    vi.mocked(isChatRunning).mockReturnValue(true)
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/spawn`, { prompt: 'x' })
      expect(r.status).toBe(409)
      expect((r.json as { error: string }).error).toContain('对话进行中')
    } finally {
      vi.mocked(isChatRunning).mockReturnValue(false)
    }
  })

  it('chat 在途 → /auto-write 409（首闸即拦，不进 chapter 校验）', async () => {
    vi.mocked(isChatRunning).mockReturnValue(true)
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/auto-write`, { chapter: 3 })
      expect(r.status).toBe(409)
      expect((r.json as { error: string }).error).toContain('对话进行中')
    } finally {
      vi.mocked(isChatRunning).mockReturnValue(false)
    }
  })

  it('chat 空闲 → 两路由越过 chat 闸（落到后续参数校验 400，未实际启动编排）', async () => {
    const spawn = await post(`/api/books/${encodeURIComponent(BOOK)}/spawn`, { prompt: '' })
    expect(spawn.status).toBe(400) // prompt 不能为空——已过互斥闸
    expect((spawn.json as { error: string }).error).toContain('prompt')
    const aw = await post(`/api/books/${encodeURIComponent(BOOK)}/auto-write`, {})
    expect(aw.status).toBe(400) // chapter 校验——已过互斥闸
    expect((aw.json as { error: string }).error).toContain('chapter')
    expect(isSelfHealRunning(BOOK)).toBe(false) // 未实际启动
  })
})
