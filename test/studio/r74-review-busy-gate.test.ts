/**
 * R74-20（七十四轮批 D）：review 三审端点补写手在途预检（orchestrationBusyFor）。
 * 修复前三审端点自身不查编排互斥（outline/analysis/onboard 等生成端点均已接）：
 * 写稿中（self-heal/chat/后台收尾）发起三审，分钟级窗口内草稿持续推进，draft_hash
 * 守卫到期必失配 → generateTool×3 白烧一次费用。
 * 锁两件事：
 * 1. chat 在途 → POST /review 409 BUSY（含「对话进行中」，不进 docId 校验）；
 * 2. chat 空闲 → 越过预检落到后续校验（未登记 docId → 404，证明闸不误伤）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { isChatRunning } from '../../src/ai/orchestrate/chat.js'

vi.mock('../../src/ai/orchestrate/chat.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/orchestrate/chat.js')>()
  return { ...orig, isChatRunning: vi.fn(() => false) }
})

const BOOK = '三审互斥书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r74-review-busy-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-r74-review-busy-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 三审互斥书\n  genre: 玄幻\nhost: cc\n',
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

describe('R74-20: review 端点写手在途预检', () => {
  it('chat 在途 → POST /review 409 BUSY（预检先于 docId 校验，未实际起三审）', async () => {
    vi.mocked(isChatRunning).mockReturnValue(true)
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/doc_unknown0000000000000000/review`, {})
      expect(r.status).toBe(409)
      const j = r.json as { code: string; error: string }
      expect(j.code).toBe('BUSY')
      expect(j.error).toContain('对话进行中')
    } finally {
      vi.mocked(isChatRunning).mockReturnValue(false)
    }
  })

  it('chat 空闲 → 越过预检落到后续校验（未登记 docId → 404 NOT_FOUND，闸不误伤）', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/doc_unknown0000000000000000/review`, {})
    expect(r.status).toBe(404)
    expect((r.json as { code: string }).code).toBe('NOT_FOUND')
  })
})
