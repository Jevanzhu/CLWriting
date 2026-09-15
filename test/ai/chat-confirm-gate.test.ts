/**
 * W2 写操作确认闸域单测（R0916-5b 拆分件，2026-09-16）。
 *
 * 拆分来源：test/ai/chat.test.ts（原「W2 对话助手 agent 编排器测试」，原头注沿革
 * 见残核 chat.test.ts）——本件承接「写操作确认闸 / 确认超时不挂起 / 中断」三个
 * describe 域整块搬移零改动（write 风险工具 pending→确认/取消续跑、超时按取消
 * 处理、abortChat 放行挂起确认）。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat, isChatRunning, abortChat, resolveChatConfirm } from '../../src/ai/orchestrate/chat.js'
import type { DriverEvent } from '../../src/driver/types.js'
import { hasChatDone, chatError } from './chat-fixtures.js'

let fake: FakeProvider
const dirs: string[] = []
let bookRoot: string

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
})

beforeEach(() => {
  bookRoot = makeDualTrackWorkdir()
  dirs.push(bookRoot)
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 带 fake provider 的 userData */
function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER
  withFakeProvider(ud, fake.url)
  return ud
}

/** 等条件满足（带超时）——实现见 test/helpers/wait-for.ts（R9-P2-2 单源） */
import { waitFor } from '../helpers/wait-for.js'

// ─── 写操作确认闸 ────────────────────────────────

describe('W2: 写操作确认闸', () => {
  it('write_chapter → chat_tool_pending 并挂起；确认后继续', async () => {
    fake.setScript([
      { type: 'tool', name: 'write_chapter', input: { chapter: 1 } },
      { type: 'text', content: '写好了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    const chatPromise = runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'test4',
      message: '帮我写第 1 章',
      confirmTimeoutMs: 5000,
    })

    // 等 pending 出现
    await waitFor(() => events.some((e) => e.type === 'chat_tool_pending'))
    const pending = events.find((e) => e.type === 'chat_tool_pending') as { callId: string } | undefined
    expect(pending).toEqual(expect.objectContaining({ type: 'chat_tool_pending' }))

    // 确认
    resolveChatConfirm('test4', pending!.callId, true)
    await chatPromise

    // 有 chat_tool（执行开始）和 chat_tool_result
    expect(events.some((e) => e.type === 'chat_tool')).toBe(true)
    expect(events.some((e) => e.type === 'chat_tool_result')).toBe(true)
  })

  it('取消确认 → tool_result isError，循环继续', async () => {
    fake.setScript([
      { type: 'tool', name: 'write_chapter', input: { chapter: 1 } },
      { type: 'text', content: '好的，那不写了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    const chatPromise = runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'test5',
      message: '帮我写第 1 章',
      confirmTimeoutMs: 5000,
    })

    await waitFor(() => events.some((e) => e.type === 'chat_tool_pending'))
    const pending = events.find((e) => e.type === 'chat_tool_pending') as { callId: string }
    resolveChatConfirm('test5', pending.callId, false) // 取消
    await chatPromise

    // 有 tool_result 且 ok=false
    const result = events.find((e) => e.type === 'chat_tool_result') as { ok: boolean; summary: string }
    expect(result).toEqual(expect.objectContaining({ type: 'chat_tool_result', ok: false }))
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('取消')

    // 循环继续到 chat_done
    expect(hasChatDone(events)).toBe(true)
  })
})

// ─── 确认超时 ────────────────────────────────────

describe('W2: 确认超时不挂起', () => {
  it('超时按取消处理', async () => {
    fake.setScript([
      { type: 'tool', name: 'write_chapter', input: { chapter: 1 } },
      { type: 'text', content: '好的。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'test6',
      message: '帮我写第 1 章',
      confirmTimeoutMs: 100, // 极短超时
    })

    const result = events.find((e) => e.type === 'chat_tool_result') as { ok: boolean }
    expect(result).toEqual(expect.objectContaining({ type: 'chat_tool_result', ok: false }))
    expect(result.ok).toBe(false) // 超时 = 取消
    expect(hasChatDone(events)).toBe(true)
  })
})

// ─── 中断 ────────────────────────────────────────

describe('W2: 中断', () => {
  it('abortChat → chat_error + 放行挂起的确认', async () => {
    // write_chapter 触发确认闸 → 在 pending 时中断
    fake.setScript([
      { type: 'tool', name: 'write_chapter', input: { chapter: 1 } },
      { type: 'text', content: '好的。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    const chatPromise = runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'test7',
      message: '帮我写第 1 章',
      confirmTimeoutMs: 10000, // 长超时，靠 abort 而非超时解除
    })

    // 等 pending 出现
    await waitFor(() => events.some((e) => e.type === 'chat_tool_pending'))

    abortChat('test7')
    await chatPromise

    // 有 chat_error（中断后循环在下一轮头部退出）
    expect(chatError(events)).not.toBeNull()
    expect(isChatRunning('test7')).toBe(false)
  })
})
