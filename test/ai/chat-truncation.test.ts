/**
 * W2 max_tokens 截断保护与历史回滚域单测（R0916-5b 拆分件，2026-09-16）。
 *
 * 拆分来源：test/ai/chat.test.ts（原「W2 对话助手 agent 编排器测试」，原头注沿革
 * 见残核 chat.test.ts）——本件承接「max_tokens 截断保护」与「R1 历史结构回归」
 * 两个 describe 域整块搬移零改动（截断不执行工具 / 截断·触顶后历史回滚，下次
 * 对话 messages 不连续同 role）。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat } from '../../src/ai/orchestrate/chat.js'
import type { DriverEvent } from '../../src/driver/types.js'
import { chatError, hasChatDone } from './chat-fixtures.js'

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

// ─── 截断保护 ────────────────────────────────────

describe('W2: max_tokens 截断保护', () => {
  it('max_tokens 响应 → chat_error，不执行工具', async () => {
    fake.setScript([{ type: 'max_tokens', partial: '半截回复' }])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
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

// ─── R1 历史结构回归（review-r P1-R1）─────────────────

/** messages 中存在连续同 role（Anthropic 400 根因：user/assistant 必须交替） */
function hasConsecutiveSameRole(messages: unknown[]): boolean {
  return messages.some((m, i) => {
    if (i === 0) return false
    const cur = (m as { role?: string }).role
    const prev = (messages[i - 1] as { role?: string }).role
    return cur === prev && cur !== undefined
  })
}

describe('R1: max_tokens / 触顶后历史不连续 user', () => {
  it('max_tokens 截断 → 历史回滚，下次对话消息不连续', async () => {
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    // 第一次对话：max_tokens 截断 → chat_error
    fake.setScript([{ type: 'max_tokens', partial: '半截回复' }])
    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'testR1a',
      message: '第一次问题',
    })
    expect(chatError(events)).toContain('截断')

    // 第二次对话：正常回复
    fake.setScript([{ type: 'text', content: '好的。' }])
    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'testR1a',
      message: '第二次问题',
    })

    // 第二次请求的 messages 不得连续同 role（P1-R1a 修复验证）
    const body = fake.lastBody()
    const messages = Array.isArray(body?.['messages']) ? (body['messages'] as unknown[]) : []
    expect(messages.length).toBeGreaterThan(0)
    expect(hasConsecutiveSameRole(messages)).toBe(false)
  })

  it('5 轮触顶 → 收尾文案入历史，下次对话消息不连续', async () => {
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    // 第一次对话：连续 6 个 tool → 第 5 轮触顶
    fake.setScript([
      { type: 'tool', name: 'check_chapter', input: { chapter: 1 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 2 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 3 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 4 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 5 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 6 } },
    ])
    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'testR1b',
      message: '查所有章节',
    })
    expect(hasChatDone(events)).toBe(true)

    // 第二次对话：正常回复
    fake.setScript([{ type: 'text', content: '好的。' }])
    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'testR1b',
      message: '继续',
    })

    const body = fake.lastBody()
    const messages = Array.isArray(body?.['messages']) ? (body['messages'] as unknown[]) : []
    expect(messages.length).toBeGreaterThan(0)
    expect(hasConsecutiveSameRole(messages)).toBe(false)
    // 历史末尾应是 assistant 收尾文案（P1-R1b：触顶文案入历史）
    const last = messages.at(-1) as { role?: string } | undefined
    const secondLast = messages.at(-2) as { role?: string; content?: unknown } | undefined
    expect(secondLast?.role).toBe('assistant')
    expect(String(secondLast?.content ?? '')).toContain('工具调用上限')
    expect(last?.role).toBe('user')
  })
})
