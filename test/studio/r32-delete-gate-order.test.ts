/**
 * R32-6（三十二轮）回归：删书闸序对齐 rename——busyGate 前置，abort 移闸后。
 *
 * 修复背景：删书先 abortSelfHeal/abortChat 后过 busyGate——闸拒绝（409，spawn/三审/
 * 任务闸在持）时在途对话已被不可逆中断，作者只是想删书却被顺带杀掉别的在途任务还
 * 删不成（rename 路径 R26-58 已闸前置，delete 未对齐）。
 * 本测试锁两件事：
 * 1. 任务闸在持 → DELETE 409 且 abortChat/abortSelfHeal 零调用（零副作用拒绝）；
 * 2. 闸释放后 → DELETE 200 且 abortChat 恰好一次（闸过才中断，中断语义不丢）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'
import { abortChat } from '../../src/ai/orchestrate/chat.js'
import { abortSelfHeal } from '../../src/ai/orchestrate/self-heal.js'

// R33D-7：recheck 复查 chat/self-heal——abortChat 必须真实翻假 isChatRunning（模拟
// abort 生效），否则删除路径的复查会按「chat 仍在跑」保守 409
const chatState = vi.hoisted(() => ({ running: true }))
vi.mock('../../src/ai/orchestrate/chat.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/orchestrate/chat.js')>()
  return {
    ...orig,
    isChatRunning: vi.fn(() => chatState.running),
    abortChat: vi.fn(() => {
      chatState.running = false // abort 生效：在途对话被中断
      return true
    }),
  }
})
vi.mock('../../src/ai/orchestrate/self-heal.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/orchestrate/self-heal.js')>()
  return { ...orig, isSelfHealRunning: vi.fn(() => false), abortSelfHeal: vi.fn(() => false) }
})

const BOOK = '删书闸序测试书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

beforeEach(() => {
  chatState.running = true // 用例隔离：每个用例重新模拟「chat 在途」
})

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r32-del-order-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-r32-del-order-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
    'utf-8',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 删书闸序测试书\nhost: cc\n', 'utf-8')
  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('R32-6：删书闸序（busyGate 前置，abort 闸后）', () => {
  it('任务闸在持 → DELETE 409 且 abortChat/abortSelfHeal 零调用（零副作用拒绝）', async () => {
    const release = acquireTaskGate(BOOK, 'analyze')!
    try {
      const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}`, {
        method: 'DELETE',
        headers: { 'x-studio-token': token },
      })
      expect(r.status).toBe(409)
      const j = (await r.json()) as { error: string }
      expect(j.error).toContain('任务在跑')
      // R32-6 锚定：闸拒绝路径不得有 abort 副作用（修复前 abortChat 已先被调用）
      expect(vi.mocked(abortChat)).not.toHaveBeenCalled()
      expect(vi.mocked(abortSelfHeal)).not.toHaveBeenCalled()
      // 书未被删
      expect((await fetch(`${baseUrl}/api/books`, { headers: { 'x-studio-token': token } })).status).toBe(200)
    } finally {
      release()
      vi.mocked(abortChat).mockClear()
      vi.mocked(abortSelfHeal).mockClear()
    }
  })

  it('闸释放后 → DELETE 200 且 abortChat 恰好一次（闸过才中断，中断语义不丢）', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}`, {
      method: 'DELETE',
      headers: { 'x-studio-token': token },
    })
    expect(r.status).toBe(200)
    // U-P2-7 中断语义保留：chat 在途（mock 真）→ 删除路径先 abort 再收尾
    expect(vi.mocked(abortChat)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(abortChat)).toHaveBeenCalledWith(BOOK)
  })
})
