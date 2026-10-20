/**
 * （R0916-7 收尾批：文件由批号命名 r35-batch-a.test.ts 改行为命名（现 responses-pseudostream-backfill.test.ts）；用例与断言零改动。）
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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { processProviderRuntime } from '../../src/ai/provider/store.js'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir, LONG_BOOK } from '../studio/fixtures.js'
import { runChat, clearChatHistory } from '../../src/ai/orchestrate/chat.js'
import { histories } from '../../src/ai/orchestrate/chat/state.js'
import { checkAiCallBudget } from '../../src/ai/calls.js'
import { runSpec, type TaskSpec } from '../../src/ai/tasks/spec.js'
import type { BookConfig } from '../../src/format/types.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'
import type { DriverEvent } from '../../src/driver/types.js'

const dirs: string[] = []

afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.CLWRITING_DRIVER
  processProviderRuntime().__resetForTest()
  await clearChatHistory('r35-tool-usage')
  await clearChatHistory('r35-ckpt-usage')
  await clearChatHistory('r35-ckpt-trunc')
})

describe('R35-1：工具轮 assistant 事件 usage 与 chat_done 同用 attemptsUsage 合并口径', () => {
  let fake: FakeProvider
  beforeAll(async () => {
    fake = await createFakeProvider()
  })
  afterAll(async () => {
    await fake.close()
  })

  it(
    '工具轮 + 截断重试：工具轮 assistant 事件 usage = 全 attempt 合并（修复前为末 attempt 单次值）',
    { timeout: 20_000 },
    async () => {
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
        driver: makeFakeDriver({ emitted: events }),
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
    },
  )
})

describe('D1-01：两类一次性重发的首发用量并入回合封套（账本按次口径对齐）', () => {
  let fake: FakeProvider
  beforeAll(async () => {
    fake = await createFakeProvider()
  })
  afterAll(async () => {
    await fake.close()
  })

  it(
    '超窗收缩重试：首发（截断 attempt + 超窗 attempt）与重试的用量合计进助理事件与 chat_done',
    { timeout: 20_000 },
    async () => {
      const ud = tempUserData()
      dirs.push(ud)
      withFakeProvider(ud, fake.url)
      const bookRoot = makeDualTrackWorkdir()
      dirs.push(bookRoot)
      const events: DriverEvent[] = []
      // 肥历史给出可切边界（纯文本 user 边界）：首发超 20k 内预切并全量发出 → 400 超窗
      const BIG = 'X'.repeat(6_000)
      histories.set('d1-01-shrink-usage', [
        { role: 'user', content: 'u0' + BIG },
        { role: 'assistant', content: 'a0' },
        { role: 'user', content: 'u1' + BIG },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' + BIG },
        { role: 'assistant', content: 'a2' },
      ])
      fake.setScript([
        // 第 1 attempt：截断流（usage {10,1} 随 NETWORK 错上抛）→ runner 退避重试
        { type: 'truncated', content: '半截', usage: { input: 10, output: 1 } },
        // 第 2 attempt：超窗 400（零增量）→ runTask 终态失败，封套带 {10,1}
        { type: 'error', status: 400, message: 'prompt is too long: 18015 tokens > 8000 maximum' },
        // 收缩重试（第二次 runTask）：成功，usage {100,50}
        { type: 'text', content: '收缩后回复。', usage: { input: 100, output: 50 } },
      ])
      await runChat({
        driver: makeFakeDriver({ emitted: events }),
        mainSession: { id: 's1', cwd: bookRoot, closed: false },
        userDataPath: ud,
        bookRoot,
        bookName: 'd1-01-shrink-usage',
        message: '继续',
      })
      // 线缆级证据：截断重试 attempt + 超窗首发 + 收缩重试恰三次
      expect(fake.requestCount()).toBe(3)

      const store = openSessionStore(ud, bookRoot)!
      const evs = store.listEvents('d1-01-shrink-usage')
      store.close()
      const assts = evs.filter((e) => e.type === 'assistant/message')
      // 修复前只有收缩重试段（{100,50}）——首发段的 {10,1} 只进账本不进封套
      expect(
        assts.some((e) => JSON.stringify(e.data['usage']) === JSON.stringify({ inputTokens: 110, outputTokens: 51 })),
      ).toBe(true)
      const done = events.find((e) => e.type === 'chat_done') as
        { inputTokens?: number; outputTokens?: number } | undefined
      expect(done?.inputTokens).toBe(110)
      expect(done?.outputTokens).toBe(51)

      // D1-05：tool_choice 参数面随 llm/call 落库——成功 attempt 取实发值，失败 attempt
      // 按调用方声明回落；本回合两次发送共三个 attempt（截断/超窗/收缩后成功）全记 'auto'
      const ws = openSessionStore(ud, bookRoot)!
      const llmCalls = ws.listEvents(bookHash(bookRoot)).filter((e) => e.type === 'llm/call')
      ws.close()
      expect(llmCalls).toHaveLength(3)
      expect(llmCalls.every((e) => e.data['toolChoice'] === 'auto')).toBe(true)
      histories.delete('d1-01-shrink-usage')
    },
  )
})

// D1-05 spec 侧：tool_choice 参数面的派生链端到端——
// spec.tool → generateTool 按模型表把 requireTool 意图翻译为实发值 → SpecOutput.toolChoice
// → runner extractToolChoice → llm/call.data.toolChoice。此回传断掉时，成功 attempt 的
// llm/call 无值可落，事件里的实发参数面与真实请求静默分叉（重放不可精确重建）。
describe('D1-05（spec 侧）：requireTool 派生 toolChoice 随 llm/call 落库', () => {
  let fake: FakeProvider
  beforeAll(async () => {
    fake = await createFakeProvider()
  })
  afterAll(async () => {
    await fake.close()
  })

  const TOOL_SPEC: TaskSpec = {
    name: 'self-heal',
    tierKind: 'creative',
    genMode: 'tool',
    systemPrompt: 's',
    tool: { def: { name: 'submit_x', description: 'd', input_schema: { type: 'object' } }, name: 'submit_x' },
  }

  /** 写指向 stub 的 providers.json；模型列决定 requireTool 的派生档位
   *（gpt 系列 named → 指名 / deepseek 系列 required → 不指名） */
  function writeProviders(ud: string, model: string): void {
    writeFileSync(
      join(ud, 'providers.json'),
      JSON.stringify({
        providers: [
          {
            id: 'prov-spec-tc',
            name: 'test',
            protocol: 'openai',
            auth: 'bearer',
            baseUrl: fake.url,
            apiKey: 'sk-test',
            model,
            caps: { connected: true, streaming: true },
          },
        ],
        currentId: 'prov-spec-tc',
        currentModel: model,
      }),
    )
  }

  /** 跑一次 tool 型 spec（真实 provider 路径）→ 返回落库的 llm/call data */
  async function runToolSpec(model: string): Promise<Record<string, unknown>[]> {
    const ud = mkdtempTracked(join(tmpdir(), 'clw-d105-spec-ud-'))
    dirs.push(ud)
    delete process.env.CLWRITING_DRIVER
    writeProviders(ud, model)
    const bookRoot = mkdtempTracked(join(tmpdir(), 'clw-d105-spec-book-'))
    dirs.push(bookRoot)
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    fake.setScript([{ type: 'tool', name: 'submit_x', input: { ok: 1 } }])
    const out = await runSpec(TOOL_SPEC, { userDataPath: ud, bookRoot, userPrompt: '写' })
    expect(out.ok).toBe(true)
    expect(fake.requestCount()).toBe(1) // 线缆级证据：请求确曾打到 stub
    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents(bookHash(bookRoot)).filter((e) => e.type === 'llm/call')
    store.close()
    expect(evs).toHaveLength(1)
    return evs.map((e) => e.data as Record<string, unknown>)
  }

  it('named 家族：requireTool 派生 toolChoice=tool（指名）随 llm/call 落库', { timeout: 20_000 }, async () => {
    const [call] = await runToolSpec('gpt-5')
    expect(call!['toolChoice']).toBe('tool')
    expect(call!['requireTool']).toBe(true)
  })

  it('required 家族：requireTool 派生 toolChoice=any（不指名）随 llm/call 落库', { timeout: 20_000 }, async () => {
    const [call] = await runToolSpec('deepseek-v4')
    expect(call!['toolChoice']).toBe('any')
    expect(call!['requireTool']).toBe(true)
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
      driver: makeFakeDriver({ emitted: [] }),
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

  it(
    '正常摘要：摘要 llm/call 携带 usage 与真实 stopReason，tasks 块计入摘要 token（修复前 usage 整链丢弃）',
    { timeout: 20_000 },
    async () => {
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

      // 账本：轮循环与摘要**各记各的 task**——同键会把两类消耗混成一份，拦截文案指不出
      // 真实来源（上限设小后，作者无从知道是「这轮发多了」还是「历史压缩吃了配额」）。
      // 修复前摘要 token 被整链丢弃，故此处也锚着「摘要真入账」这条。
      const rec = JSON.parse(readFileSync(join(bookRoot, '.cache', 'ai-calls.json'), 'utf8')) as {
        tasks: Record<string, { used: number; inputTokens: number; outputTokens: number }>
      }
      expect(rec.tasks['chat']).toEqual(expect.objectContaining({ used: 1, inputTokens: 100, outputTokens: 40 }))
      expect(rec.tasks['chat_compact']).toEqual(
        expect.objectContaining({ used: 1, inputTokens: 300, outputTokens: 20 }),
      )
    },
  )

  it(
    '摘要被 max_tokens 截断：stopReason 如实记 max_tokens + 截断 usage 入账（修复前谎记 end_turn）',
    { timeout: 20_000 },
    async () => {
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
    },
  )
})

describe('R35-16：chapter 块 token 字段坏值判 corrupt（与 tasks 块读校验对称）', () => {
  const CONFIG = { budget: { calls_per_chapter: 3 } } as unknown as BookConfig

  function writeLedger(root: string, rec: unknown): void {
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(join(root, '.cache', 'ai-calls.json'), JSON.stringify(rec), 'utf8')
  }

  it('inputTokens 非数字 → 保守阻断（修复前静默归 0 放行，烂账不可见）', () => {
    const root = mkdtempTracked(join(tmpdir(), 'clwriting-r35-calls-'))
    dirs.push(root)
    writeLedger(root, { chapter: { num: 1, used: 2, inputTokens: '100', outputTokens: 50 }, tasks: {} })
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.reason).toContain('损坏')
  })

  it('缺 outputTokens 字段 → 同判 corrupt（tasks 块同款口径）', () => {
    const root = mkdtempTracked(join(tmpdir(), 'clwriting-r35-calls-'))
    dirs.push(root)
    writeLedger(root, { chapter: { num: 1, used: 1, inputTokens: 10 }, tasks: {} })
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(false)
  })

  it('对照：合法记录（无 cache/cost 可选字段）读入不损坏', () => {
    const root = mkdtempTracked(join(tmpdir(), 'clwriting-r35-calls-'))
    dirs.push(root)
    writeLedger(root, { chapter: { num: 1, used: 1, inputTokens: 10, outputTokens: 20 }, tasks: {} })
    const b = checkAiCallBudget(root, 1, CONFIG)
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.used).toBe(1)
  })
})
