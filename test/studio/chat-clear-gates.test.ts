/**
 * M-2（第六轮）回归：POST /api/books/:name/chat/clear 补齐 audit DELETE 同款闸。
 *
 * 修复背景：clearChatHistory 是双键清理（bookName + bookHash 工作流会话），audit DELETE
 * 已配五闸（isChatRunning / heldTaskGatesFor / isSelfHealRunning / hasBackgroundTasks /
 * isSpawnRunning），chat/clear 此前只有两道（isChatRunning + hasBackgroundTasks）——
 * task-gate 任务 / self-heal 批量写稿在途时清空清不彻底，收尾事件追加到已删 session
 * 的行上成孤儿。
 * 本测试锁三件事：
 * 1. task-gate 在途（真实占位）→ 409 拒清，事件库两侧原样；
 * 2. self-heal 运行中 → 409 拒清；
 * 3. 全空闲 → 200 且两侧清空（闸不误伤）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { stepStartEvent } from '../../src/events/chain-bridge.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'
import { isSelfHealRunning } from '../../src/ai/orchestrate/self-heal.js'

vi.mock('../../src/ai/orchestrate/self-heal.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/orchestrate/self-heal.js')>()
  return { ...orig, isSelfHealRunning: vi.fn(() => false) }
})

const BOOK = '清对话闸书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-chat-clear-gates-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-chat-clear-gates-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 清对话闸书\n  genre: 玄幻\nhost: cc\n',
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

function post(path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: { origin: baseUrl, 'x-studio-token': token },
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
    req.end()
  })
}

/** 工作流侧事件计数（bookHash 键——闸要保护的另一侧）。 */
function workflowEvents(): number {
  const bookRoot = join(workDir, BOOK)
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    return store.listEvents(bookHash(bookRoot)).length
  } finally {
    store.close()
  }
}

function seedWorkflowEvent(): void {
  const bookRoot = join(workDir, BOOK)
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    const wsSid = store.workspaceSession(bookHash(bookRoot))
    store.appendEvents(wsSid, [stepStartEvent('chat', 'chat')])
  } finally {
    store.close()
  }
}

describe('M-2: chat/clear 五闸对齐', () => {
  it('task-gate 在途（真实占位）→ 409 拒清，工作流侧事件原样', async () => {
    seedWorkflowEvent()
    const release = acquireTaskGate(BOOK, 'analyze')!
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/chat/clear`)
      expect(r.status).toBe(409)
      expect((r.json as { error: string }).error).toContain('任务在跑')
      expect(workflowEvents()).toBe(1) // 未被清掉
    } finally {
      release()
    }
  })

  it('self-heal 运行中 → 409 拒清', async () => {
    vi.mocked(isSelfHealRunning).mockReturnValue(true)
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/chat/clear`)
      expect(r.status).toBe(409)
      expect((r.json as { error: string }).error).toContain('自动写稿')
      expect(workflowEvents()).toBe(1)
    } finally {
      vi.mocked(isSelfHealRunning).mockReturnValue(false)
    }
  })

  it('全空闲 → 200 且工作流侧清空（闸不误伤）', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/chat/clear`)
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)
    expect(workflowEvents()).toBe(0)
  })
})
