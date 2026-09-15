/**
 * W2 对话助手 agent 编排器测试。
 *
 * 用 fake-provider 跑真实 HTTP 全链路（非 mock 分支）。
 * 验收：单轮/工具循环/确认闸/取消/中断/触顶/截断保护/回滚。
 *
 * 拆分沿革（R0916-5b，2026-09-16）：原 1011 行按 describe 域拆为五件——
 * chat-confirm-gate.test.ts（写操作确认闸/确认超时/中断）/ chat-max-turns.test.ts
 *（轮数触顶 + CC-P2-1 turn 终态 + CC-P2-2 deadline）/ chat-truncation.test.ts
 *（max_tokens 截断保护 + R1 历史结构回归）/ chat-read-bounds.test.ts（read_chapter
 * ·read_skill 有界返回与截断口径四域）/ chat-lineage.test.ts（F1-P3 血缘 + F1-P4
 * 分支）；共享事件助手抽 chat-fixtures.ts（chatTexts/hasChatDone/chatError）。
 * 本件保留 W2 编排主链残核（单轮纯文本 / R73-11 空消息入口 / 工具循环 / 只读
 * 工具免确认 / Q1 锁泄漏回归 / X-P2-12 章号回落），用例零改动。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat, isChatRunning, abortChat, sendChatMessage } from '../../src/ai/orchestrate/chat.js'
import type { DriverEvent } from '../../src/driver/types.js'
import { chatTexts, hasChatDone } from './chat-fixtures.js'

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

// ─── 单轮纯文本 ──────────────────────────────────

describe('W2: 单轮纯文本', () => {
  it('AI 回复无工具调用 → chat_done', async () => {
    fake.setScript([
      { type: 'text', content: '主角应该选择谈判。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
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

// ─── R73-11：空用户消息入口拒绝 ────────────────────

describe('R73-11: 空用户消息入口拒绝', () => {
  it('空串/纯空白 message → rejected + 人话 error 事件，不启动链路不入历史', () => {
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    for (const message of ['', '   ']) {
      events.length = 0
      const r = sendChatMessage({
        driver,
        mainSession: { id: 's1', cwd: bookRoot, closed: false },
        userDataPath: ud,
        bookRoot,
        bookName: 'test-r73-empty',
        message,
      })
      // 修复前：放行进历史，消毒后数组可能为空 → provider 400 报原始英文文案
      expect(r).toBe('rejected')
      const err = events.find((e) => e.type === 'error') as { message: string } | undefined
      expect(err).toBeDefined()
      expect(err!.message).toContain('消息内容为空')
    }
    expect(isChatRunning('test-r73-empty')).toBe(false)
  })

  it('regenerate 不带 message，不在守卫范围（返回 started 而非 rejected）', async () => {
    fake.setScript([{ type: 'text', content: '好' }])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    const r = sendChatMessage({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'test-r73-regen',
      message: '',
      regenerate: { parentSeq: 1, branchId: 'main' },
    })
    expect(r).toBe('started')
    abortChat('test-r73-regen')
    await waitFor(() => !isChatRunning('test-r73-regen'))
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
    const driver = makeFakeDriver({ emitted: events })
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
    expect(toolResult).toEqual(expect.objectContaining({ type: 'chat_tool_result' }))

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
    const driver = makeFakeDriver({ emitted: events })
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

// ─── Q1 锁泄漏回归（review-q P1-Q1）─────────────────

describe('Q1: runChat 并发锁不泄漏', () => {
  it('buildChatContext 抛异常 → 锁释放，后续对话不 409', async () => {
    // mock buildChatContext 抛读盘异常（Q1 复现路径：readCharacterCards 降级 readFileSync 抛）
    const mock = vi.spyOn(await import('../../src/ai/prompts/chat.js'), 'buildChatContext')
    mock.mockImplementation(() => { throw new Error('模拟读盘异常') })

    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    await expect(
      runChat({
        driver,
        mainSession: { id: 's1', cwd: bookRoot, closed: false },
        userDataPath: ud,
        bookRoot,
        bookName: 'testQ1',
        message: '测试锁释放',
      }),
    ).rejects.toThrow('模拟读盘异常')

    // 锁必须已释放——否则后续对话 409「本书正在对话中」
    expect(isChatRunning('testQ1')).toBe(false)

    mock.mockRestore()
  })
})

// ─── X-P2-12 check_chapter 章号回落 ─────────────────
describe('X-P2-12: check_chapter 省略 chapter 入参 → 回落作者选定章', () => {
  it('input 无 chapter + opts.chapter=1 → 回落查第 1 章（不再「章号需为正整数」被拒）', async () => {
    fake.setScript([
      { type: 'tool', name: 'check_chapter', input: {} }, // AI 常省略入参
      { type: 'text', content: '查完了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()
    // 长篇书（有正文 0001-初入宗门.md）——回落章号后能真跑到机检
    const longRoot = join(bookRoot, '长篇', '长篇测试书')

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot: longRoot,
      bookName: 'testXp212a',
      message: '帮我查这章',
      chapter: 1,
    })

    const result = events.find((e) => e.type === 'chat_tool_result') as { summary?: string } | undefined
    expect(result).toBeTruthy()
    // 回落成功：不再是参数错误，也不是「草稿不存在」（第 1 章正文在 fixture 里）
    expect(result?.summary).not.toBe('章号需为正整数。')
    expect(result?.summary).not.toBe('第1章草稿不存在。')
  })

  it('input 无 chapter 且 opts.chapter 也缺 → 才报「章号需为正整数」', async () => {
    fake.setScript([
      { type: 'tool', name: 'check_chapter', input: {} },
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
      bookName: 'testXp212b',
      message: '帮我查一章',
    })

    const result = events.find((e) => e.type === 'chat_tool_result') as { summary?: string } | undefined
    expect(result?.summary).toBe('章号需为正整数。')
  })
})
