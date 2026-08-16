/**
 * E1a（steer / B5 Inbox 合流）测试：对话消息入队 + 自动续链 + 丢弃。
 * 用 fake-provider 跑真实 HTTP 全链路。
 * 验收：运行中入队 → 当前轮完成自动续链；abort/error → 丢弃队列。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { isChatRunning, abortChat, sendChatMessage, runChat, getHistory } from '../../src/ai/orchestrate/chat.js'
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

function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER
  withFakeProvider(ud, fake.url)
  return ud
}

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

async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout after ' + timeoutMs + 'ms')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function sendMsg(ud: string, bookName: string, message: string, driver: StudioDriver) {
  return sendChatMessage({
    driver,
    mainSession: { id: 's1', cwd: bookRoot, closed: false },
    userDataPath: ud,
    bookRoot,
    bookName,
    message,
  })
}

describe('E1a: steer 入队与续链', () => {
  it('运行中入队 → 当前轮正常完成自动续链（两个 chat_done）', async () => {
    fake.setScript([
      { type: 'text', content: '第一轮回复。' },
      { type: 'text', content: '第二轮回复。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = setup()
    const bookName = 'steer-chain'

    expect(sendMsg(ud, bookName, '第一条消息', driver)).toBe('started')
    // 等第一轮真正开跑（running 已登记）
    await waitFor(() => isChatRunning(bookName))
    // 运行中入队 → queued
    expect(sendMsg(ud, bookName, '第二条消息', driver)).toBe('queued')

    // 自动续链：两个 chat_done
    await waitFor(() => events.filter((e) => e.type === 'chat_done').length >= 2, 6000)
    expect(events.filter((e) => e.type === 'chat_start').length).toBe(2)
    const texts = events.filter((e) => e.type === 'chat_text').map((e) => (e as { text: string }).text).join('')
    expect(texts).toContain('第一轮回复')
    expect(texts).toContain('第二轮回复')
    expect(isChatRunning(bookName)).toBe(false)
  })

  it('abort → 丢弃待处理队列（第二轮不跑）', async () => {
    fake.setScript([
      { type: 'text', content: '第一轮回复。' },
      { type: 'text', content: '第二轮（不应出现）。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = setup()
    const bookName = 'steer-abort'

    expect(sendMsg(ud, bookName, '第一条', driver)).toBe('started')
    await waitFor(() => isChatRunning(bookName))
    expect(sendMsg(ud, bookName, '第二条', driver)).toBe('queued')

    abortChat(bookName)
    await waitFor(() => !isChatRunning(bookName))
    await sleep(200) // 给足续链窗口
    expect(events.some((e) => e.type === 'chat_done')).toBe(false)
    expect(events.filter((e) => e.type === 'chat_text').map((e) => (e as { text: string }).text).join('')).not.toContain('第二轮')
  })

  it('无运行直接启动（不排队）', async () => {
    fake.setScript([{ type: 'text', content: '好的。' }])
    const ud = setup()
    const driver = makeDriver([])
    expect(sendMsg(ud, 'steer-plain', '你好', driver)).toBe('started')
    await waitFor(() => !isChatRunning('steer-plain'))
  })

  it('AA-P3-1: 队列超容丢最旧 → emit notice（丢弃可感知，不再零感知）', async () => {
    // 第一轮挂起 2s 制造在途窗口——期间可入队 11 条（容量 10），第 11 条挤掉最旧
    fake.setScript([
      { type: 'text', content: '第一轮回复。', delayMs: 2000 },
      { type: 'text', content: '续链回复。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = setup()
    const bookName = 'steer-overflow'

    expect(sendMsg(ud, bookName, '第一条', driver)).toBe('started')
    await waitFor(() => isChatRunning(bookName))
    // 连发 11 条排队消息（2..12）：容量 10 → 第 12 条触发丢最旧（第2条）
    for (let i = 2; i <= 12; i++) {
      expect(sendMsg(ud, bookName, `第${i}条`, driver)).toBe('queued')
    }
    // 丢弃必须可感知：notice 事件带被丢消息预览
    const notices = events.filter((e) => e.type === 'notice') as Array<{ message: string }>
    expect(notices).toHaveLength(1)
    expect(notices[0]!.message).toContain('已丢弃最旧的排队消息')
    expect(notices[0]!.message).toContain('第2条')

    // 全部续链跑完（第一轮 + 保留下来的 10 条），收尾无残留
    await waitFor(() => !isChatRunning(bookName), 15_000)
    expect(events.filter((e) => e.type === 'chat_done').length).toBe(11)
  }, 25_000)
})

// ── RB-AI-P2-1：续链逐条字段不继承 base（regenerate/chapter 语义保真）──

describe('RB-AI-P2-1: 续链字段污染', () => {
  /** 跑一轮直连对话（setup 用，非队列路径），返回事件数组 */
  async function runOne(ud: string, bookName: string, message: string, driver: StudioDriver): Promise<void> {
    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName,
      message,
    })
  }

  /** 取本书首条 user/message 事件的全局 seq（regenerate 的 parentSeq 锚点） */
  function firstUserSeq(ud: string, bookName: string): number {
    const store = openSessionStore(ud, bookRoot)!
    try {
      const seq = store.listEvents(bookName).find((e) => e.type === 'user/message')!.seq
      return seq
    } finally {
      store.close()
    }
  }

  it('运行中 regenerate → 排队的新消息正常入历史+写事件（不被 regenerate 分支吞掉）', async () => {
    const ud = setup()
    const bookName = 'steer-p21a'
    const events: DriverEvent[] = []
    const driver = makeDriver(events)

    // 第一轮普通对话建立锚点 user 消息
    fake.setScript([{ type: 'text', content: '初版回复。' }])
    await runOne(ud, bookName, '第一问', driver)
    const userSeq = firstUserSeq(ud, bookName)

    // regenerate 运行中（delayMs 制造窗口）→ 排队一条新消息
    fake.setScript([
      { type: 'text', content: '重写版回复。', delayMs: 1500 },
      { type: 'text', content: '排队消息的回复。' },
    ])
    expect(
      sendChatMessage({
        driver,
        mainSession: { id: 's1', cwd: bookRoot, closed: false },
        userDataPath: ud,
        bookRoot,
        bookName,
        regenerate: { parentSeq: userSeq, branchId: 'r1' },
      }),
    ).toBe('started')
    await waitFor(() => isChatRunning(bookName))
    expect(sendMsg(ud, bookName, '排队的新消息', driver)).toBe('queued')

    // setup 轮 + regenerate 轮 + 排队消息轮 = 3 个 chat_done，且收尾无残留
    await waitFor(() => !isChatRunning(bookName) && events.filter((e) => e.type === 'chat_done').length >= 3, 8000)

    // 排队消息必须入事件库（user/message）+ 产生回复——修复前续链继承 base.regenerate
    // → 走「恢复旧历史」分支：不 push 不写事件，排队消息静默丢失
    const store = openSessionStore(ud, bookRoot)!
    try {
      const evs = store.listEvents(bookName)
      expect(evs.some((e) => e.type === 'user/message' && e.data['message'] === '排队的新消息')).toBe(true)
      expect(evs.some((e) => e.type === 'assistant/message' && e.data['message'] === '排队消息的回复。')).toBe(true)
    } finally {
      store.close()
    }
    // 内存历史同样含排队消息
    expect(getHistory(bookName).some((m) => m.role === 'user' && m.content === '排队的新消息')).toBe(true)
  }, 15_000)

  it('运行中普通消息 → 排队的 regenerate 保持 regenerate 语义（不降级为空消息）', async () => {
    const ud = setup()
    const bookName = 'steer-p21b'
    const events: DriverEvent[] = []
    const driver = makeDriver(events)

    fake.setScript([{ type: 'text', content: '第一轮回复。' }])
    await runOne(ud, bookName, '第一问', driver)
    const userSeq = firstUserSeq(ud, bookName)

    // 普通消息运行中（delayMs 制造窗口）→ 排队一个 regenerate
    fake.setScript([
      { type: 'text', content: '第二轮回复。', delayMs: 1500 },
      { type: 'text', content: '重生成版回复。' },
    ])
    expect(sendMsg(ud, bookName, '第二问', driver)).toBe('started')
    await waitFor(() => isChatRunning(bookName))
    expect(
      sendChatMessage({
        driver,
        mainSession: { id: 's1', cwd: bookRoot, closed: false },
        userDataPath: ud,
        bookRoot,
        bookName,
        regenerate: { parentSeq: userSeq, branchId: 'q1' },
      }),
    ).toBe('queued')

    // setup 轮 + 第二问轮 + 排队 regenerate 轮 = 3 个 chat_done，且收尾无残留
    await waitFor(() => !isChatRunning(bookName) && events.filter((e) => e.type === 'chat_done').length >= 3, 8000)

    const store = openSessionStore(ud, bookRoot)!
    try {
      const evs = store.listEvents(bookName)
      // regenerate 语义保真：重生成 assistant 事件带 branchId=q1（修复前降级为空 message
      // 的普通回合——无 branchId，且写一条空 user/message 事件）
      const regen = evs.find((e) => e.type === 'assistant/message' && e.data['message'] === '重生成版回复。')
      expect(regen).toBeDefined()
      expect(regen!.data['branchId']).toBe('q1')
      expect(regen!.data['parentSeq']).toBe(userSeq)
      // 不得出现空消息事件（降级路径的痕迹）
      expect(evs.filter((e) => e.type === 'user/message').every((e) => String(e.data['message'] ?? '') !== '')).toBe(true)
    } finally {
      store.close()
    }
  }, 15_000)
})

