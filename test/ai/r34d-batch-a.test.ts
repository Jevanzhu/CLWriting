/**
 * R34D 批 A（三十四轮）回归——AI 链路 usage 口径与降级记忆标记时序：
 *
 * - R34D-1：runner 可重试分支把 GenError.usage 硬记 null——截断带 usage 机制（B-12/R31-1）
 *   引入后属过期假设。修后重试两分支（正常退避 / Retry-After 超封顶）与 abort、终态失败
 *   分支同口径：usage 在手按真实消耗入账（attemptsUsage）+ 入 trace（llm/call 事件）。
 * - R34D-7：降级记忆 per-key 标记原在 saveProviders 落定前同步置位——排队段一旦失败本
 *   进程内该 key 永久短路不再重试。修后标记移入 save 成功回调，失败保持未标记自然重试。
 * - R34D-9：chat assistant 事件用单 attempt 的 out.usage，与 chat_done（R27-3）的
 *   attemptsUsage 合并口径不一致。修后统一合并口径（线缆级：截断带 usage → 重试成功）。
 */
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runTask, resolveProvider, degradedPersistedKeysForTest } from '../../src/ai/runner.js'
import { GenError } from '../../src/ai/gen.js'
import { loadProviders, persistDegraded, resetDegradedChannels, __seedProvidersWriteChainForTest } from '../../src/ai/provider/store.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData as fixturesTempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat } from '../../src/ai/orchestrate/chat.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'

const dirs: string[] = []
function tempUserData(): string {
  const d = mkdtempSync(join(tmpdir(), 'clwriting-r34d-ud-'))
  dirs.push(d)
  return d
}
function tempBookRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'clwriting-r34d-book-'))
  dirs.push(d)
  return d
}
function writeProviders(userDataPath: string): void {
  writeFileSync(
    join(userDataPath, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'prov-test',
          name: 'test',
          protocol: 'openai',
          auth: 'bearer',
          baseUrl: 'http://localhost:1',
          apiKey: 'sk-test',
          caps: { connected: true, streaming: true },
        },
      ],
      currentId: 'prov-test',
      currentModel: 'gpt-4o',
    }),
  )
}

function readChainEvents(userDataPath: string, bookRoot: string) {
  const store = openSessionStore(userDataPath, bookRoot)!
  try {
    return store.listEvents(bookHash(bookRoot))
  } finally {
    store.close()
  }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.CLWRITING_DRIVER
  resetDegradedChannels()
})

describe('R34D-1：重试分支随 GenError.usage 入账/入 trace（不再硬记 null）', () => {
  // 截断随错上抛形态（R31-1/B-12 通道）：可重试 GenError 携带网关已返回 usage——
  // 既有重试用例的 GenError 均不带 usage，这正是该口径漂移长期漏网的原因
  const truncErr = (): GenError =>
    new GenError('传输截断：流结束无终止事件', true, { code: 'NETWORK', usage: { inputTokens: 10, outputTokens: 5 } })

  it('attemptsUsage 合并失败 attempt 用量（recordUsage 通道）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    let calls = 0
    const out = await runTask<{ usage: { inputTokens: number; outputTokens: number } }>({
      userDataPath: ud,
      run: () => {
        calls++
        if (calls < 2) throw truncErr()
        return Promise.resolve({ usage: { inputTokens: 100, outputTokens: 50 } })
      },
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 50 })
      // 修复前重试分支 recordUsageSafe(null) → attemptsUsage 只累计到末 attempt（100/50）
      expect(out.attemptsUsage).toEqual({ inputTokens: 110, outputTokens: 55 })
    }
  }, 10_000)

  it('失败 attempt 的 llm/call 事件携带 usage（trace 通道，toTraceUsage input/output 形态）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    let calls = 0
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'self-heal',
      run: () => {
        calls++
        if (calls < 2) throw truncErr()
        return Promise.resolve('ok')
      },
    })
    expect(out.ok).toBe(true)
    const callsEv = readChainEvents(ud, root).filter((e) => e.type === 'llm/call')
    expect(callsEv).toHaveLength(2)
    const fail = callsEv.find((e) => (e.data as { ok?: boolean }).ok === false)!.data as { attempt: number; usage?: { input: number; output: number } }
    expect(fail.attempt).toBe(0)
    // 修复前该事件 usage 为 undefined（硬记 null → llmCallEvent 落 undefined）
    expect(fail.usage).toEqual({ input: 10, output: 5 })
  }, 10_000)

  it('RETRY_AFTER_OVER_CAP 分支同口径：Retry-After 超封顶且 GenError 带 usage → 入 trace', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'self-heal',
      run: () => {
        // retryAfterMs 120s > maxDelayMs 30s → 不重试（终态），走 Retry-After 超封顶分支
        throw new GenError('429 limit', true, { code: 'RATE_LIMIT', retryAfterMs: 120_000, usage: { inputTokens: 7, outputTokens: 3 } })
      },
    })
    expect(out).toMatchObject({ ok: false, code: 'GEN_FAIL' })
    const call = readChainEvents(ud, root).find((e) => e.type === 'llm/call')!.data as Record<string, unknown>
    expect(call['errCode']).toBe('RETRY_AFTER_OVER_CAP')
    expect(call['usage']).toEqual({ input: 7, output: 3 })
  }, 10_000)

  it('无 usage 的可重试失败保持 null 口径（多数失败响应无 usage，行为不变）', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    const root = tempBookRoot()
    let calls = 0
    const out = await runTask<string>({
      userDataPath: ud,
      bookRoot: root,
      task: 'self-heal',
      run: () => {
        calls++
        if (calls < 2) throw new GenError('429 limit', true)
        return Promise.resolve('ok')
      },
    })
    expect(out.ok).toBe(true)
    const callsEv = readChainEvents(ud, root).filter((e) => e.type === 'llm/call')
    expect(callsEv).toHaveLength(2)
    const fail = callsEv.find((e) => (e.data as { ok?: boolean }).ok === false)!.data as { usage?: unknown }
    expect(fail.usage).toBeUndefined()
  }, 10_000)
})

describe('R34D-7：降级记忆 per-key 标记在 saveProviders 成功后才置位', () => {
  it('排队段 save 失败 → 不标记；修复后下轮 persistDegraded 自然重试成功落盘', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    resolveProvider(ud) // 注册降级记忆双通道回调（ok 与否不影响注册）
    const memoKey = `${ud}\u0000model-x`

    // 制造「排队段失败」：seed 在途写链使 saveProviders 走排队路径；persistDegraded 同步
    // 返回后、排队 save 微任务执行前，把 providers.json 换成目录 → 落盘段 EISDIR 失败
    __seedProvidersWriteChainForTest(ud, Promise.resolve())
    persistDegraded('model-x', ud)
    rmSync(join(ud, 'providers.json'))
    mkdirSync(join(ud, 'providers.json'))
    await new Promise((r) => setTimeout(r, 30))
    // 修复前置位发生在 save 落定前 → 失败也标 → 此处为 has=true 且此后永久短路
    expect(degradedPersistedKeysForTest().has(memoKey)).toBe(false)

    // 解除故障 → 同 key 再次 persistDegraded 自然重试 → 落盘成功 + 标记置位
    rmdirSync(join(ud, 'providers.json'))
    writeProviders(ud)
    persistDegraded('model-x', ud)
    await new Promise((r) => setTimeout(r, 30))
    expect(degradedPersistedKeysForTest().has(memoKey)).toBe(true)
    expect(loadProviders(ud).modelCaps['model-x']?.structured).toBe(false)
  })

  it('成功路径标记置位；置位后同 key 再 persist 纯 memo 命中零落盘', async () => {
    const ud = tempUserData()
    writeProviders(ud)
    resolveProvider(ud)
    const memoKey = `${ud}\u0000model-y`
    // 同拍两次：标记在 save 成功微任务才置位（R34D-7），置位前的重复 persist 可能
    // 落「读盘已含」收口、也可能在写链在途窗内重复写同值（fixture 明文 apiKey 触发
    // 迁移写占链）——两者均无害（同值幂等，R34D-7 注释既有口径），不按 revision
    // 精确计数断言；幂等保证的锚点是**置位后**的第三次 persist 零落盘。
    persistDegraded('model-y', ud)
    persistDegraded('model-y', ud)
    await new Promise((r) => setTimeout(r, 30))
    expect(degradedPersistedKeysForTest().has(memoKey)).toBe(true)
    const s = loadProviders(ud)
    expect(s.modelCaps['model-y']?.structured).toBe(false)
    // 置位后第三次：memo 命中直接 return，不得再写盘（revision 不再递增）
    persistDegraded('model-y', ud)
    await new Promise((r) => setTimeout(r, 30))
    const s2 = loadProviders(ud)
    expect(s2.revision).toBe(s.revision)
    expect(s2.modelCaps['model-y']?.structured).toBe(false)
  })
})

describe('R34D-9：assistant/message 事件与 chat_done 同用 attemptsUsage 合并口径', () => {
  let fake: FakeProvider
  let bookRoot: string
  const chatDirs: string[] = []

  beforeAll(async () => {
    fake = await createFakeProvider()
  })
  afterAll(async () => {
    await fake.close()
  })

  /** 线缆级驱动一轮 chat（同 chat-events.test.ts 形态）：fake provider 走真实 openai 适配器全链路 */
  let lastUd = ''
  async function runOne(bookName: string, message: string): Promise<DriverEvent[]> {
    const ud = fixturesTempUserData()
    chatDirs.push(ud)
    lastUd = ud
    withFakeProvider(ud, fake.url)
    const events: DriverEvent[] = []
    await runChat({
      driver: {
        async startSession(cwd: string): Promise<Session> {
          return { id: 'mock', cwd, closed: false }
        },
        async *stream(): AsyncGenerator<DriverEvent> {},
        dispose(): void {},
        emit(_s, ev): void {
          events.push(ev)
        },
      } satisfies StudioDriver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName,
      message,
    })
    return events
  }

  it('截断带 usage → 重试成功：assistant 事件 usage = 全 attempt 合并（修复前为末 attempt 单次值）', async () => {
    bookRoot = makeDualTrackWorkdir()
    chatDirs.push(bookRoot)
    // 第 1 次请求：截断流（usage {10,1} 随 NETWORK 错上抛）→ runTask 退避重试；
    // 第 2 次请求：正常完成（usage {100,50}）
    fake.setScript([
      { type: 'truncated', content: '半截', usage: { input: 10, output: 1 } },
      { type: 'text', content: '重试成功回复。', usage: { input: 100, output: 50 } },
    ])
    const events = await runOne('r34d-usage', '问题')
    expect(fake.requestCount()).toBe(2) // 线缆级证据：首 attempt 截断后确曾重试

    const store = openSessionStore(lastUd, bookRoot)!
    const evs = store.listEvents('r34d-usage')
    store.close()
    const asst = evs.find((e) => e.type === 'assistant/message')
    expect(asst).toBeDefined()
    // 修复前 = {100,50}（末 attempt 单次值）；修复后与 chat_done（R27-3 合并口径）一致
    expect(asst!.data['usage']).toEqual({ inputTokens: 110, outputTokens: 51 })
    expect(asst!.data['stopReason']).toBe('stop')

    const done = events.find((e) => e.type === 'chat_done') as { inputTokens?: number; outputTokens?: number } | undefined
    expect(done).toBeDefined()
    expect(done?.inputTokens).toBe(110)
    expect(done?.outputTokens).toBe(51)
  }, 20_000)
})
