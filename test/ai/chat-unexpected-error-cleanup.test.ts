/**
 * 0918独立重评修复批（A002）回归：runChatInner 未预期异常的失败收尾。
 *
 * 现状：try/finally 无 catch——restore 相位 createSession SQLITE_BUSY 等未预期异常
 * 穿透时 history 悬挂、事件库无终态、无 chat_error。修法：try 与 finally 之间补
 * catch——prepared 在手且未完成 → finishTurn({error}) 同款收尾（回滚 + 遮蔽 +
 * chat_error）；prepared 未产出（准备期抛）→ best-effort 补 chat_error；正常完成后
 * （completedOk=true，chat_done 已发）的收尾段异常不回滚不二次收尾；末尾 rethrow
 * 对外契约不变。防双收尾守卫 = completedOk + prepared 双标记（六失败出口调
 * finishTurn 后同步 return，无「finishTurn 后再抛」窗口，见 chat.ts catch 注）。
 * 断言面：
 * ① stub prepareChatRun 抛 → 正常 reject、chat_error 发出、running 并发锁清理；
 * ② stub runAgentTurns 中途抛（history 已 push user）→ finishTurn 被调：history 回滚、
 *   session/end reason=error（遮蔽收尾）、chat_error 按 {error} 口径；
 * ③ 正常完成路径不触发 catch 收尾（无 chat_error，正常 done）。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { saveProviders, type ProviderStore } from '../../src/ai/provider/store.js'
import { runChat, isChatRunning, getHistory } from '../../src/ai/orchestrate/chat.js'
import { openSessionStore } from '../../src/events/store.js'
import { chatTexts, hasChatDone, chatError } from './chat-fixtures.js'
import type { DriverEvent } from '../../src/driver/types.js'

// stub 载体（vi.mock 工厂提升作用域——用 vi.hoisted 共享可变槽位）
const stubs = vi.hoisted(() => ({
  prepareError: null as Error | null,
  turnsError: null as Error | null,
}))

// restore.js 部分mock：仅 prepareChatRun 可注入抛错，其余透传真身
vi.mock('../../src/ai/orchestrate/chat/restore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/orchestrate/chat/restore.js')>()
  return {
    ...actual,
    prepareChatRun: (
      opts: Parameters<typeof actual.prepareChatRun>[0],
      store: Parameters<typeof actual.prepareChatRun>[1],
      onRecorder: Parameters<typeof actual.prepareChatRun>[2],
    ) => {
      if (stubs.prepareError) throw stubs.prepareError
      return actual.prepareChatRun(opts, store, onRecorder)
    },
  }
})

// turns.js 部分 mock：仅 runAgentTurns 可注入中途抛错，其余透传真身
vi.mock('../../src/ai/orchestrate/chat/turns.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/orchestrate/chat/turns.js')>()
  return {
    ...actual,
    runAgentTurns: (deps: Parameters<typeof actual.runAgentTurns>[0]) => {
      if (stubs.turnsError) throw stubs.turnsError
      return actual.runAgentTurns(deps)
    },
  }
})

let fake: FakeProvider
const dirs: string[] = []
let bookRoot: string

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  bookRoot = makeDualTrackWorkdir()
  dirs.push(bookRoot)
  stubs.prepareError = null
  stubs.turnsError = null
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  stubs.prepareError = null
  stubs.turnsError = null
})

function prov(id: string): ProviderStore['providers'][number] {
  return {
    id,
    name: id,
    protocol: 'openai',
    auth: 'bearer',
    baseUrl: fake.url,
    model: 'fake-model',
    apiKey: `sk-${id}`,
    caps: { connected: true, streaming: true },
    capsProbedAt: Date.now(),
  }
}

function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER
  saveProviders(ud, {
    providers: [prov('fake-a')],
    currentId: 'fake-a',
    currentModel: 'fake-model',
    modelCaps: {},
    ragProviders: [],
    tiers: { creative: { model: 'fake-model', effort: 'medium' }, assistant: null, chat: null },
    revision: 0,
    vault: null,
    dek: null,
  })
  return ud
}

const RUN = () => ({ cwd: bookRoot, closed: false })

describe('runChatInner 未预期异常的失败收尾（A002）', () => {
  it('① prepareChatRun 抛（模拟 createSession SQLITE_BUSY）→ 正常 reject、chat_error 发出、running 清理', async () => {
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()
    stubs.prepareError = new Error('模拟 restore createSession SQLITE_BUSY')
    const p = runChat({
      driver,
      mainSession: { id: 's1', ...RUN() },
      userDataPath: ud,
      bookRoot,
      bookName: 'ue-prepare',
      message: '你好',
    })
    // 对外契约不变：异常照旧穿透（函数正常 reject）
    await expect(p).rejects.toThrow('SQLITE_BUSY')
    // 准备期异常（run 未产出）→ best-effort 补 chat_error 终态
    expect(chatError(events)).toContain('SQLITE_BUSY')
    // running 并发锁清理（finally 兜底）
    expect(isChatRunning('ue-prepare')).toBe(false)
  })

  it('② runAgentTurns 中途抛（history 已 push user）→ finishTurn 收尾：回滚 + 遮蔽 + chat_error', async () => {
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()
    stubs.turnsError = new Error('轮循环中途未预期异常')
    await expect(
      runChat({
        driver,
        mainSession: { id: 's1', ...RUN() },
        userDataPath: ud,
        bookRoot,
        bookName: 'ue-turns',
        message: '记一下',
      }),
    ).rejects.toThrow('未预期')
    // {error} 口径：finishTurn 发 chat_error（文案 = errMsg，无凭据模式脱敏为恒等）
    expect(chatError(events)).toContain('轮循环中途未预期异常')
    // history 回滚到 baseLen（prepareChatRun 的 user push 已被回滚）
    expect(getHistory('ue-turns').length).toBe(0)
    // 事件库有终态：session/end reason=error（closeMaskingAll 遮蔽收尾）
    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents('ue-turns')
    store.close()
    const end = evs.find((e) => e.type === 'session/end')
    expect(end).toBeDefined()
    expect((end!.data as { reason?: string }).reason).toBe('error')
  })

  it('③ 正常完成路径不触发 catch 收尾（chat_done 正常、无 chat_error）', async () => {
    fake.setScript([{ type: 'text', content: '正常回答。' }])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()
    await runChat({
      driver,
      mainSession: { id: 's1', ...RUN() },
      userDataPath: ud,
      bookRoot,
      bookName: 'ue-normal',
      message: '你好',
    })
    expect(chatTexts(events).join('')).toContain('正常回答')
    expect(hasChatDone(events)).toBe(true)
    expect(chatError(events)).toBeNull()
    expect(isChatRunning('ue-normal')).toBe(false)
  })
})
