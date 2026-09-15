/**
 * W2 轮数触顶与 deadline 域单测（R0916-5b 拆分件，2026-09-16）。
 *
 * 拆分来源：test/ai/chat.test.ts（原「W2 对话助手 agent 编排器测试」，原头注沿革
 * 见残核 chat.test.ts）——本件承接「轮数触顶」describe 域整块搬移零改动（连吐
 * tool 第 5 轮停补收尾文案 / CC-P2-1 触顶收尾 turn 终态 / CC-P2-2 deadline 到点
 * 在确认闸等待期强制中止并回滚历史）。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat, isChatRunning, getHistory } from '../../src/ai/orchestrate/chat.js'
import { openSessionStore } from '../../src/events/store.js'
import type { DriverEvent } from '../../src/driver/types.js'
import { chatTexts, hasChatDone, chatError } from './chat-fixtures.js'

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
    const driver = makeFakeDriver({ emitted: events })
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

  it('CC-P2-1: 触顶收尾记 turn 5 终态——最后一轮（turn 4）不再被重复收尾', async () => {
    fake.setScript([
      { type: 'tool', name: 'check_chapter', input: { chapter: 1 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 2 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 3 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 4 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 5 } },
      { type: 'tool', name: 'check_chapter', input: { chapter: 6 } },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'test8-ev',
      message: '查所有章节',
    })

    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents('test8-ev')
    store.close()
    const turnEnds = evs
      .filter((e) => e.type === 'turn/end')
      .map((e) => ({ turn: e.turn ?? -1, reason: (e.data as { reason: string }).reason }))
    // 5 轮各一个 completed 终态 + 触顶收尾一个 turn 5 max-turns——同轮双终态消除
    expect(turnEnds).toEqual([
      { turn: 0, reason: 'completed' },
      { turn: 1, reason: 'completed' },
      { turn: 2, reason: 'completed' },
      { turn: 3, reason: 'completed' },
      { turn: 4, reason: 'completed' },
      { turn: 5, reason: 'max-turns' },
    ])
  })

  it('CC-P2-2: deadline 到点在确认闸等待期间强制中止（报「对话超时」并回滚历史）', async () => {
    // write 风险工具 → 挂起等作者确认；deadline 先于确认超时（60s）触发。
    // 2026-08-24 CI 复校：原 300ms 窗口过窄——ubuntu·Node 24 共享 runner 高负载时
    // （同跑 check/scale 500 章规模测试等 CPU 峰），deadline 在 chat_tool_pending
    // 事件发出前即到点（run 32742346585，「挂起确已发生」断言红）。放宽到 2s：
    // 工具派发有充足余量，仍 << 60s 确认超时，测试意图（超时落在 await 点上）不变。
    fake.setScript([
      { type: 'tool', name: 'rename_chapter', input: { chapter: 1, title: '新标题' } },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'test-dl',
      message: '帮我改名',
      deadlineMs: 2_000,
      confirmTimeoutMs: 60_000,
    })

    // 确认闸确已挂起（超时发生在 await 点上，而非轮首检查的空转路径）
    expect(events.some((e) => e.type === 'chat_tool_pending')).toBe(true)
    expect(chatError(events)).toContain('对话超时')
    // 超时回滚：本书历史不留半截回合
    expect(getHistory('test-dl').length).toBe(0)
    expect(isChatRunning('test-dl')).toBe(false)
  })
})
