/**
 * W2 对话助手 agent 编排器测试。
 *
 * 用 fake-provider 跑真实 HTTP 全链路（非 mock 分支）。
 * 验收：单轮/工具循环/确认闸/取消/中断/触顶/截断保护/回滚。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat, isChatRunning, abortChat, resolveChatConfirm } from '../../src/ai/orchestrate/chat.js'
import { openSessionStore } from '../../src/events/store.js'
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
    expect(chatError(events)).not.toBeNull()
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

// ─── Q1 锁泄漏回归（review-q P1-Q1）─────────────────

describe('Q1: runChat 并发锁不泄漏', () => {
  it('buildChatContext 抛异常 → 锁释放，后续对话不 409', async () => {
    // mock buildChatContext 抛读盘异常（Q1 复现路径：readCharacterCards 降级 readFileSync 抛）
    const mock = vi.spyOn(await import('../../src/ai/prompts/chat.js'), 'buildChatContext')
    mock.mockImplementation(() => { throw new Error('模拟读盘异常') })

    const events: DriverEvent[] = []
    const driver = makeDriver(events)
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
    const driver = makeDriver(events)
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
    const driver = makeDriver(events)
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

// ─── X-P2-12 check_chapter 章号回落 ─────────────────

describe('X-P2-12: check_chapter 省略 chapter 入参 → 回落作者选定章', () => {
  it('input 无 chapter + opts.chapter=1 → 回落查第 1 章（不再「章号需为正整数」被拒）', async () => {
    fake.setScript([
      { type: 'tool', name: 'check_chapter', input: {} }, // AI 常省略入参
      { type: 'text', content: '查完了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
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
    const driver = makeDriver(events)
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

// ─── F1-P3 血缘事件 ───────────────────────────────

describe('F1-P3 chat 血缘事件', () => {
  it('单轮对话：settings/snapshot 登记 + assistant sourceSeqs 引用（可回溯、早于 assistant）', async () => {
    fake.setScript([{ type: 'text', content: '答案是谈判。' }])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'lineage-e2e',
      message: '主角该硬闯还是谈判？',
    })
    expect(hasChatDone(events)).toBe(true)

    // 读事件库（对话会话 book = bookName）
    const store = openSessionStore(ud, bookRoot)!
    try {
      const evs = store.listEvents('lineage-e2e')
      const snap = evs.find((e) => e.type === 'settings/snapshot')
      expect(snap).toBeDefined()
      expect((snap!.data as { scope: string }).scope).toBe('settings')
      expect(typeof (snap!.data as { digest: string }).digest).toBe('string')

      const asst = evs.find((e) => e.type === 'assistant/message')
      expect(asst).toBeDefined()
      expect(asst!.sourceSeqs).toBeDefined()
      expect(asst!.sourceSeqs!.length).toBeGreaterThan(0)
      // 完整来源链可回溯：每个引用 seq 都能在事件流定位，且早于 assistant
      for (const s of asst!.sourceSeqs!) {
        expect(evs.some((e) => e.seq === s)).toBe(true)
        expect(s).toBeLessThan(asst!.seq)
      }
      // settings/snapshot seq 被 assistant 引用
      expect(asst!.sourceSeqs).toContain(snap!.seq)
    } finally {
      store.close()
    }
  })
})
