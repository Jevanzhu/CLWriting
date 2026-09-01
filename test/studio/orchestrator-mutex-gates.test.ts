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
import { startServerSafe } from '../helpers/safe-port.js'
import { isChatRunning } from '../../src/ai/orchestrate/chat.js'
import { isSelfHealRunning, isChatEmbeddedSelfHealRunning } from '../../src/ai/orchestrate/self-heal.js'
import { __setSpawnRunning } from '../../src/ai/orchestrate/spawn-registry.js'

vi.mock('../../src/ai/orchestrate/chat.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/orchestrate/chat.js')>()
  return { ...orig, isChatRunning: vi.fn(() => false) }
})
vi.mock('../../src/ai/orchestrate/self-heal.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/orchestrate/self-heal.js')>()
  return {
    ...orig,
    isSelfHealRunning: vi.fn(() => false),
    isChatEmbeddedSelfHealRunning: vi.fn(() => false),
  }
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
  server = await startServerSafe({ port: 0, workDir, userDataPath })
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

  it('M-2（第八轮）：spawn 在途 → /auto-write 409（矩阵最后一角：auto-write × spawn）', async () => {
    __setSpawnRunning(BOOK, true)
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/auto-write`, { chapter: 3 })
      expect(r.status).toBe(409)
      expect((r.json as { error: string }).error).toContain('手动写稿')
      expect(isSelfHealRunning(BOOK)).toBe(false) // 未实际启动 self-heal
    } finally {
      __setSpawnRunning(BOOK, false)
    }
  })

  // R-9（第十六轮）：chat 入口补 spawn/self-heal 反向互斥——互斥矩阵此前只补了
  // spawn/auto-write 侧的 isChatRunning 检查，chat 侧反向缺失（写手在途时发对话 =
  // 两路 runTask 互覆预算章块/草稿）。锁 chat.send 与 chat/regenerate 两入口。
  it('R-9: self-heal 在途 → POST /chat 409（不进 sendChatMessage）', async () => {
    vi.mocked(isSelfHealRunning).mockReturnValue(true)
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/chat`, { message: '你好' })
      expect(r.status).toBe(409)
      expect((r.json as { error: string }).error).toContain('全自动写章')
    } finally {
      vi.mocked(isSelfHealRunning).mockReturnValue(false)
    }
  })

  it('R-9: spawn 在途 → POST /chat 409（首闸即拦）', async () => {
    __setSpawnRunning(BOOK, true)
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/chat`, { message: '你好' })
      expect(r.status).toBe(409)
      expect((r.json as { error: string }).error).toContain('手动写稿')
    } finally {
      __setSpawnRunning(BOOK, false)
    }
  })

  it('R-9: self-heal 在途 → POST /chat/regenerate 409（闸先于 body 校验）', async () => {
    vi.mocked(isSelfHealRunning).mockReturnValue(true)
    try {
      // body 故意空缺 parentSeq/branchId——若闸缺失会落到 400 参数校验
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/chat/regenerate`, {})
      expect(r.status).toBe(409)
      expect((r.json as { error: string }).error).toContain('全自动写章')
    } finally {
      vi.mocked(isSelfHealRunning).mockReturnValue(false)
    }
  })

  it('R-9: spawn 在途 → POST /chat/regenerate 409', async () => {
    __setSpawnRunning(BOOK, true)
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/chat/regenerate`, { parentSeq: 1, branchId: 'b' })
      expect(r.status).toBe(409)
      expect((r.json as { error: string }).error).toContain('手动写稿')
    } finally {
      __setSpawnRunning(BOOK, false)
    }
  })

  // R32-7（三十二轮）：regenerate 补 R76-12 嵌套写章豁免（与 chat.send 口径对齐）——
  // chat 自己的 write_chapter 在途（isSelfHealRunning 真 + 嵌套标记真）时，原样 409
  // 把 regenerate 拒之门外且文案误导（报「全自动写章进行中」，实为 chat 自身嵌套生成）
  it('R32-7: chat 嵌套写章在途 → /chat/regenerate 豁免 self-heal/任务闸（落到 body 校验 400）', async () => {
    vi.mocked(isSelfHealRunning).mockReturnValue(true)
    vi.mocked(isChatEmbeddedSelfHealRunning).mockReturnValue(true)
    try {
      // body 故意空缺 parentSeq/branchId——过闸即落到 400 参数校验（未实际续体）
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/chat/regenerate`, {})
      expect(r.status).toBe(400)
      expect((r.json as { error: string }).error).toContain('parentSeq')
    } finally {
      vi.mocked(isSelfHealRunning).mockReturnValue(false)
      vi.mocked(isChatEmbeddedSelfHealRunning).mockReturnValue(false)
    }
  })

  // 独立写稿（非嵌套）维持 409——豁免不得放大到全自动写稿在途场景
  it('R32-7 对照: 独立 self-heal 在途（非嵌套）→ /chat/regenerate 仍 409', async () => {
    vi.mocked(isSelfHealRunning).mockReturnValue(true)
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/chat/regenerate`, {})
      expect(r.status).toBe(409)
      expect((r.json as { error: string }).error).toContain('全自动写章')
    } finally {
      vi.mocked(isSelfHealRunning).mockReturnValue(false)
    }
  })
})
