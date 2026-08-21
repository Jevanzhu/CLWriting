/**
 * M-1（第六轮）回归：chat 的嵌套 AI 生成 + 章记账工具（rewrite_chapter /
 * rewrite_selection / lead_update）与 self-heal 互斥。
 *
 * 修复背景：calls.ts 章预算块按「同书同时只有一路生成」记账，write_chapter 分支一直
 * 有 isSelfHealRunning 闸，注册表三工具漏配——并发时两编排以不同章号交替调
 * recordAiCall，章号互覆把对方账块 fresh 重置清零，used/tokens/cost 三口径全部低估，
 * 预算闸（防自动写章烧钱的那道）被绕过。
 * 本测试锁两件事：
 * 1. self-heal 运行中 → 三工具被闸（summary 明示原因，无嵌套生成副作用）；
 * 2. self-heal 空闲 → rewrite_chapter 正常放行（闸不误伤）。
 * 三工具均为 write 级确认闸工具——先 resolveChatConfirm 放行确认，闸测的是执行层互斥。
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeProvider, type FakeProvider } from '../fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { runChat, resolveChatConfirm } from '../../../src/ai/orchestrate/chat.js'
import { isSelfHealRunning } from '../../../src/ai/orchestrate/self-heal.js'
import { isSpawnRunning } from '../../../src/ai/orchestrate/spawn-registry.js'
import type { DriverEvent, Session, StudioDriver } from '../../../src/driver/types.js'

vi.mock('../../../src/ai/orchestrate/self-heal.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/ai/orchestrate/self-heal.js')>()
  return { ...orig, isSelfHealRunning: vi.fn(() => false) }
})

// M-2（第八轮）：闸补查 spawn 手动写稿——mock spawn-registry 的判定函数
vi.mock('../../../src/ai/orchestrate/spawn-registry.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/ai/orchestrate/spawn-registry.js')>()
  return { ...orig, isSpawnRunning: vi.fn(() => false) }
})

let fake: FakeProvider
const dirs: string[] = []
let workDir: string
let bookRoot: string

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
})

beforeEach(() => {
  workDir = makeDualTrackWorkdir()
  bookRoot = join(workDir, '长篇', LONG_BOOK)
  dirs.push(workDir)
  vi.mocked(isSelfHealRunning).mockReturnValue(false)
  vi.mocked(isSpawnRunning).mockReturnValue(false)
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER
  withFakeProvider(ud, fake.url)
  return ud
}

function makeDriver(emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void {
      emitted.push(ev)
    },
  }
}

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function runConfirmedToolChat(script: unknown[]): Promise<DriverEvent[]> {
  const events: DriverEvent[] = []
  const driver = makeDriver(events)
  fake.setScript(script as never)
  const chatPromise = runChat({
    driver,
    mainSession: { id: 's1', cwd: workDir, closed: false },
    userDataPath: setup(),
    bookRoot,
    bookName: 'ai-gen-gate',
    message: '执行工具',
    confirmTimeoutMs: 5000,
  })
  // write 级工具先过确认闸
  await waitFor(() => events.some((e) => e.type === 'chat_tool_pending'))
  const pending = events.find((e) => e.type === 'chat_tool_pending') as { callId: string } | undefined
  resolveChatConfirm('ai-gen-gate', pending!.callId, true)
  await chatPromise
  return events
}

describe('M-1: AI 生成类 chat 工具与 self-heal 互斥', () => {
  it('self-heal 运行中 → rewrite_chapter 被闸，无嵌套生成副作用', { timeout: 15_000 }, async () => {
    vi.mocked(isSelfHealRunning).mockReturnValue(true)
    const events = await runConfirmedToolChat([
      { type: 'tool', name: 'rewrite_chapter', input: { chapter: 1, instruction: '压缩' } },
      { type: 'text', content: '知道了。' },
    ])
    expect(events.some((e) => e.type === 'chat_tool_result')).toBe(true)
    // 闸原因可感知（AI 据此告知作者，而不是误判失败重试）
    expect(JSON.stringify(events)).toContain('无法同时改写')
    // 未发生嵌套生成：无改写 spill 产物
    expect(existsSync(join(bookRoot, '工作区', 'spills'))).toBe(false)
  })

  it('self-heal 运行中 → lead_update 同样被闸', { timeout: 15_000 }, async () => {
    vi.mocked(isSelfHealRunning).mockReturnValue(true)
    const events = await runConfirmedToolChat([
      { type: 'tool', name: 'lead_update', input: { chapter: 1 } },
      { type: 'text', content: '好的。' },
    ])
    expect(JSON.stringify(events)).toContain('无法同时改写')
    // 未生成账本推进草稿
    expect(existsSync(join(bookRoot, '工作区', '账本推进.md'))).toBe(false)
  })

  it('self-heal 空闲 → rewrite_chapter 正常放行（闸不误伤）', { timeout: 15_000 }, async () => {
    const events = await runConfirmedToolChat([
      { type: 'tool', name: 'rewrite_chapter', input: { chapter: 1, instruction: '压缩' } },
      { type: 'text', content: '改写后的全文内容。' },
      { type: 'text', content: '改完了。' },
    ])
    expect(JSON.stringify(events)).not.toContain('无法同时改写')
    // 放行后真实走到嵌套生成：spill 产物存在
    expect(existsSync(join(bookRoot, '工作区', 'spills'))).toBe(true)
  })

  it('M-2（第八轮）：spawn 手动写稿运行中 → rewrite_chapter 同样被闸', { timeout: 15_000 }, async () => {
    vi.mocked(isSpawnRunning).mockReturnValue(true)
    try {
      const events = await runConfirmedToolChat([
        { type: 'tool', name: 'rewrite_chapter', input: { chapter: 1, instruction: '压缩' } },
        { type: 'text', content: '知道了。' },
      ])
      expect(JSON.stringify(events)).toContain('无法同时改写')
      expect(existsSync(join(bookRoot, '工作区', 'spills'))).toBe(false)
    } finally {
      vi.mocked(isSpawnRunning).mockReturnValue(false)
    }
  })
})
