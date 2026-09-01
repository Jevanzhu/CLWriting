/**
 * R35 第三十五轮评审修复批 A（AI 链路）回归：
 *
 * - R35-1：chat 工具轮 assistant 事件的 usage 漏改 attemptsUsage 合并口径
 *   （R34D-9 当时只改了无工具路径两处）——「工具轮 + 截断重试」线缆级回归，
 *   修复前工具轮事件只记末 attempt 单次值，与 ai-calls 按次入账分裂。
 * - R35-2：checkpoint 摘要调用的 usage/stopReason 被整链丢弃——长对话中输入最大的
 *   真实计费调用不进任何账本；摘要被 max_tokens 截断时 stopReason 谎记 end_turn。
 * - R35-16：ai-calls.json chapter 块 token 字段坏值静默归 0，与 tasks 块判 corrupt
 *   的读校验不对称——对齐后坏值保守阻断。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { resetDegradedChannels } from '../../src/ai/provider/store.js'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir, LONG_BOOK } from '../studio/fixtures.js'
import { runChat, clearChatHistory } from '../../src/ai/orchestrate/chat.js'
import { histories } from '../../src/ai/orchestrate/chat/state.js'
import { checkAiCallBudget } from '../../src/ai/calls.js'
import type { BookConfig } from '../../src/format/types.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.CLWRITING_DRIVER
  resetDegradedChannels()
  clearChatHistory('r35-tool-usage')
  clearChatHistory('r35-ckpt-usage')
  clearChatHistory('r35-ckpt-trunc')
})

/** 事件收集型 driver（r34d-batch-a 同款线缆级形态） */
function makeDriver(events: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void {
      events.push(ev)
    },
  } satisfies StudioDriver
}

describe('R35-1：工具轮 assistant 事件 usage 与 chat_done 同用 attemptsUsage 合并口径', () => {
  let fake: FakeProvider
  beforeAll(async () => {
    fake = await createFakeProvider()
  })
  afterAll(async () => {
    await fake.close()
  })

  it('工具轮 + 截断重试：工具轮 assistant 事件 usage = 全 attempt 合并（修复前为末 attempt 单次值）', { timeout: 20_000 }, async () => {
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    const bookRoot = makeDualTrackWorkdir()
    dirs.push(bookRoot)
    const events: DriverEvent[] = []
    // 第 1 attempt：截断流（usage {10,1} 随 NETWORK 错上抛）→ runTask 退避重试；
    // 第 2 attempt：工具调用完成（usage {100,50}）；第 2 轮：文本收尾（usage {200,60}）
    fake.setScript([
      { type: 'truncated', content: '半截', usage: { input: 10, output: 1 } },
      { type: 'tool', name: 'book_search', input: { query: '玉佩' }, usage: { input: 100, output: 50 } },
      { type: 'text', content: '最终回复。', usage: { input: 200, output: 60 } },
    ])
    await runChat({
      driver: makeDriver(events),
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'r35-tool-usage',
      message: '第 3 章写得如何？',
    })
    expect(fake.requestCount()).toBe(3) // 线缆级证据：工具轮确曾截断重试

    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents('r35-tool-usage')
    store.close()
    const assts = evs.filter((e) => e.type === 'assistant/message')
    expect(assts).toHaveLength(2)
    // 首条 assistant = 工具轮（tool_use block 在载荷里）
    expect(Array.isArray(assts[0]!.data['message'])).toBe(true)
    expect(assts[0]!.data['stopReason']).toBe('tool_use')
    // 修复前 = {100,50}（末 attempt 单次值）；修复后与按次入账的合并口径一致
    expect(assts[0]!.data['usage']).toEqual({ inputTokens: 110, outputTokens: 51 })
    // 末条 assistant（无工具完成轮，未重试）= 单 attempt 原值，口径不受影响
    expect(assts[1]!.data['usage']).toEqual({ inputTokens: 200, outputTokens: 60 })
  })
})

describe('R35-2：checkpoint 摘要调用的 usage/stopReason 进账本与 llm/call', () => {
  let fake: FakeProvider
  beforeAll(async () => {
    fake = await createFakeProvider()
  })
  afterAll(async () => {
    await fake.close()
  })

  /** 预灌 11 回合历史（> keepTurns=10）——加上本回合必触发收尾压缩（checkpoint-owner 同款） */
  function seedOverflowHistory(book: string): void {
    const h: ChatMsg[] = []
    for (let i = 1; i <= 11; i++) {
      h.push({ role: 'user', content: `问题${i}：` + '细节'.repeat(30) })
      h.push({ role: 'assistant', content: `回答${i}：` + '内容'.repeat(30) })
    }
    histories.set(book, h)
  }

  /** 线缆级驱动一轮 chat；返回书根与事件库中的 llm/call、step/end（workspace 会话） */
  async function runWithOverflow(book: string): Promise<{
    bookRoot: string
    llmCalls: Record<string, unknown>[]
    stepEnds: Record<string, unknown>[]
  }> {
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    const workDir = makeDualTrackWorkdir()
    dirs.push(workDir)
    const bookRoot = join(workDir, '长篇', LONG_BOOK)
    seedOverflowHistory(book)
    await runChat({
      driver: makeDriver([]),
      mainSession: { id: 's1', cwd: workDir, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: book,
      message: '继续',
    })
    const store = openSessionStore(ud, bookRoot)!
    const chainEvs = store.listEvents(bookHash(bookRoot))
    store.close()
    return {
      bookRoot,
      llmCalls: chainEvs.filter((e) => e.type === 'llm/call').map((e) => e.data as Record<string, unknown>),
      stepEnds: chainEvs.filter((e) => e.type === 'step/end').map((e) => e.data as Record<string, unknown>),
    }
  }

  it('正常摘要：摘要 llm/call 携带 usage 与真实 stopReason，tasks 块计入摘要 token（修复前 usage 整链丢弃）', { timeout: 20_000 }, async () => {
    fake.setScript([
      { type: 'text', content: '本回合的答复。', usage: { input: 100, output: 40 } },
      { type: 'text', content: '摘要：作者推进到第 1 卷，玉佩悬念已埋。', usage: { input: 300, output: 20 } },
    ])
    const { bookRoot, llmCalls } = await runWithOverflow('r35-ckpt-usage')

    expect(llmCalls).toHaveLength(2) // 轮循环 + 摘要
    const summary = llmCalls[1]!
    // 修复前：usage undefined（run 回调不带 → extractUsage null）+ stopReason 恒 'end_turn'
    expect(summary['usage']).toEqual({ input: 300, output: 20 })
    expect(summary['stopReason']).toBe('stop')

    // 账本：tasks['chat'] 两笔全入（轮循环 + 摘要）——修复前摘要 token 被丢弃只入轮循环
    const rec = JSON.parse(readFileSync(join(bookRoot, '.cache', 'ai-calls.json'), 'utf8')) as {
      tasks: Record<string, { used: number; inputTokens: number; outputTokens: number }>
    }
    expect(rec.tasks['chat']).toEqual(expect.objectContaining({ used: 2, inputTokens: 400, outputTokens: 60 }))
  })

  it('摘要被 max_tokens 截断：stopReason 如实记 max_tokens + 截断 usage 入账（修复前谎记 end_turn）', { timeout: 20_000 }, async () => {
    fake.setScript([
      { type: 'text', content: '本回合的答复。' },
      { type: 'max_tokens', partial: '摘要写到一半', usage: { input: 300, output: 5000 } },
    ])
    const { llmCalls, stepEnds } = await runWithOverflow('r35-ckpt-trunc')
    expect(llmCalls).toHaveLength(2)
    const summary = llmCalls[1]!
    // 修复前：run 回调不含 stopReason → extractStopReason 兜底 'end_turn'（谎报正常完成）
    expect(summary['stopReason']).toBe('max_tokens')
    expect(summary['usage']).toEqual({ input: 300, output: 5000 })
    // 摘要 runTask 收尾的 step/end 同口径（修复前恒 'completed'）
    expect(stepEnds.at(-1)!['reason']).toBe('max-tokens')
  })
})

describe('R35-16：chapter 块 token 字段坏值判 corrupt（与 tasks 块读校验对称）', () => {
  const CONFIG = { budget: { calls_per_chapter: 3 } } as unknown as BookConfig

  function writeLedger(root: string, rec: unknown): void {
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', 'ai-calls.json'), JSON.stringify(rec), 'utf8')
  }

  it('inputTokens 非数字 → 保守阻断（修复前静默归 0 放行，烂账不可见）', () => {
    const root = mkdtempSync(join(tmpdir(), 'clwriting-r35-calls-'))
    dirs.push(root)
    writeLedger(root, { chapter: { num: 1, used: 2, inputTokens: '100', outputTokens: 50 }, tasks: {} })
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.reason).toContain('损坏')
  })

  it('缺 outputTokens 字段 → 同判 corrupt（tasks 块同款口径）', () => {
    const root = mkdtempSync(join(tmpdir(), 'clwriting-r35-calls-'))
    dirs.push(root)
    writeLedger(root, { chapter: { num: 1, used: 1, inputTokens: 10 }, tasks: {} })
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(false)
  })

  it('对照：合法记录（无 cache/cost 可选字段）读入不损坏', () => {
    const root = mkdtempSync(join(tmpdir(), 'clwriting-r35-calls-'))
    dirs.push(root)
    writeLedger(root, { chapter: { num: 1, used: 1, inputTokens: 10, outputTokens: 20 }, tasks: {} })
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.used).toBe(1)
  })
})
