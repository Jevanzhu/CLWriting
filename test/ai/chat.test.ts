/**
 * W2 对话助手 agent 编排器测试。
 *
 * 用 fake-provider 跑真实 HTTP 全链路（非 mock 分支）。
 * 验收：单轮/工具循环/确认闸/取消/中断/触顶/截断保护/回滚。
 */
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider, type FakeResponse } from './fake-provider.js'
import { withFakeProvider, tempUserData, SHORT_BOOK, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat, isChatRunning, abortChat, resolveChatConfirm } from '../../src/ai/orchestrate/chat.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'

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

/** 最小 driver（捕获 emit 事件） */
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

/** 从事件中提取 chat_* 类型的文本内容 */
function chatTexts(events: DriverEvent[]): string[] {
  return events.filter((e) => e.type === 'chat_text').map((e) => (e as { text: string }).text)
}

/** chat_done 事件存在 */
function hasChatDone(events: DriverEvent[]): boolean {
  return events.some((e) => e.type === 'chat_done')
}

/** chat_error 事件 */
function chatError(events: DriverEvent[]): string | null {
  const ev = events.find((e) => e.type === 'chat_error')
  return ev ? (ev as { error: string }).error : null
}

/** 等条件满足（带超时） */
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

// ─── 单轮纯文本 ──────────────────────────────────

describe('W2: 单轮纯文本', () => {
  it('AI 回复无工具调用 → chat_done', async () => {
    fake.setScript([
      { type: 'text', content: '主角应该选择谈判。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'test',
      message: '主角该硬闯还是谈判？',
    })

    expect(events.some((e) => e.type === 'chat_start')).toBe(true)
    expect(chatTexts(events).join('')).toContain('主角应该选择谈判')
    expect(hasChatDone(events)).toBe(true)
    expect(isChatRunning('test')).toBe(false)
  })
})

// ─── 工具循环 ────────────────────────────────────

describe('W2: 工具循环', () => {
  it('脚本 [tool, text] → 2 次请求；第 2 次含 tool_result 配对', async () => {
    fake.setScript([
      { type: 'tool', name: 'check_chapter', input: { chapter: 1 } },
      { type: 'text', content: '第 1 章机检已执行。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'test2',
      message: '帮我查第 1 章',
    })

    // 2 次请求
    expect(fake.requestCount()).toBe(2)

    // 第 2 次请求体含 role:'tool' 消息（OpenAI 格式）
    const body2 = fake.lastBody()
    const messages = body2!['messages'] as Record<string, unknown>[]
    const toolMsgs = messages.filter((m) => m['role'] === 'tool')
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1)

    // chat_tool_result 事件存在
    const toolResult = events.find((e) => e.type === 'chat_tool_result')
    expect(toolResult).toBeDefined()

    // 最终有 chat_done
    expect(hasChatDone(events)).toBe(true)
  })
})

// ─── 只读工具免确认 ──────────────────────────────

describe('W2: 只读工具免确认', () => {
  it('check_chapter 不发 chat_tool_pending，直接 chat_tool', async () => {
    fake.setScript([
      { type: 'tool', name: 'check_chapter', input: { chapter: 1 } },
      { type: 'text', content: '查完了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'test3',
      message: '查第 1 章',
    })

    expect(events.some((e) => e.type === 'chat_tool_pending')).toBe(false)
    expect(events.some((e) => e.type === 'chat_tool')).toBe(true)
  })
})

// ─── 写操作确认闸 ────────────────────────────────

describe('W2: 写操作确认闸', () => {
  it('write_chapter → chat_tool_pending 并挂起；确认后继续', async () => {
    fake.setScript([
      { type: 'tool', name: 'write_chapter', input: { chapter: 1 } },
      { type: 'text', content: '写好了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
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
    expect(pending).toBeDefined()

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
    const driver = makeDriver(events)
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
    expect(result).toBeDefined()
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
    const driver = makeDriver(events)
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
    expect(result).toBeDefined()
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
    const driver = makeDriver(events)
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
    expect(chatError(events)).toBeTruthy()
    expect(isChatRunning('test7')).toBe(false)
  })
})

// ─── 轮数触顶 ────────────────────────────────────

describe('W2: 轮数触顶', () => {
  it('连吐 6 个 tool → 第 5 轮后停，补收尾文案', async () => {
    // 6 个 tool 响应（超出 MAX_AGENT_TURNS=5）
    fake.setScript([
      { type: 'tool', name: 'check_chapter', input: { chapter: 1 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 2 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 3 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 4 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 5 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 6 } },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'test8',
      message: '查所有章节',
    })

    // 触顶文案
    expect(chatTexts(events).join('')).toContain('工具调用上限')
    expect(hasChatDone(events)).toBe(true)
    // 不超过 5 轮请求
    expect(fake.requestCount()).toBeLessThanOrEqual(5)
  })
})

// ─── 截断保护 ────────────────────────────────────

describe('W2: max_tokens 截断保护', () => {
  it('max_tokens 响应 → chat_error，不执行工具', async () => {
    fake.setScript([
      { type: 'max_tokens', partial: '半截回复' },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'test9',
      message: '随便聊聊',
    })

    expect(chatError(events)).toContain('截断')
    // 不应有工具事件
    expect(events.some((e) => e.type === 'chat_tool')).toBe(false)
  })
})
