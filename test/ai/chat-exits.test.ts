/**
 * hh §八-16 出口走查：六失败出口 → finishTurn 单一出口的口径回归。
 *
 * 六出口 → 四类 reason 的映射（出口位次按拆分前 runChat 相位 d 内的原始分支）：
 * ① 轮首中止且 deadline 定时器已触发 → timeout   ② 轮首中止（用户中断）→ interrupted
 * ③ 轮首 deadline 检查 → timeout                ④ !ok 且 deadline 期间触发 → timeout
 * ⑤ !ok（provider 错误）→ { error } 透传        ⑥ max_tokens → max-tokens
 *
 * ①③为同码位的兜底双检查（定时器与 Date.now 同时到点，遮蔽实参与文案完全同构），
 * 本文件以 ①④ 两路径代表 timeout 双入口。每类各断言四件套：
 * chat_error 文案（驱动事件）/ session/end reason（事件库终态实参）/
 * surface user 消息 seq 被 compaction replace 遮蔽（GG-P2-1 幽灵消息口径）/
 * 内存历史回滚到 baseLen（P1-S4/R1a 连续 user 防线）。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat, abortChat, getHistory } from '../../src/ai/orchestrate/chat.js'
import { SessionRecorder } from '../../src/events/chat-bridge.js'
import { openSessionStore } from '../../src/events/store.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'
import type { ChatEvent } from '../../src/events/types.js'

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
  delete process.env.CLWRITING_DRIVER
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
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

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 跑一轮并断言失败出口四件套：文案 / 终态 reason / surface 遮蔽 / 历史回滚 */
async function assertExit(
  bookName: string,
  ud: string,
  expectError: (msg: string) => void,
  expectReason: string,
  extra?: { deadlineMs?: number; confirmTimeoutMs?: number },
): Promise<void> {
  const events: DriverEvent[] = []
  await runChat({
    driver: makeDriver(events),
    mainSession: { id: 's1', cwd: bookRoot, closed: false },
    userDataPath: ud,
    bookRoot,
    bookName,
    message: '出口走查',
    ...extra,
  })
  const err = events.find((e) => e.type === 'chat_error') as { error: string } | undefined
  expect(err).toBeDefined()
  expectError(err!.error)

  const store = openSessionStore(ud, bookRoot)!
  try {
    const evs = store.listEvents(bookName)
    // 终态实参：session/end.data.reason 与 closeMaskingAll 入参一致
    const end = evs.find((e) => e.type === 'session/end') as (ChatEvent & { data: { reason: string } }) | undefined
    expect(end?.data.reason).toBe(expectReason)
    // surface user 消息被 compaction replace 遮蔽（GG-P2-1：遮蔽区间只盖曾可见节点）
    const userSeq = (evs.find((e) => e.type === 'user/message') as ChatEvent | undefined)?.seq
    expect(userSeq).toBeDefined()
    const shadowed = evs.some(
      (e) =>
        e.type === 'compaction/end' &&
        e.shadowStart !== undefined &&
        e.shadowEnd !== undefined &&
        e.shadowStart <= userSeq! &&
        userSeq! <= e.shadowEnd,
    )
    expect(shadowed).toBe(true)
  } finally {
    store.close()
  }
  // 历史回滚：失败出口后本书内存历史不含本轮 user（下次对话不连续 user）
  expect(getHistory(bookName).length).toBe(0)
}

describe('hh §八-16 出口走查：finishTurn 单一出口', () => {
  it('④ timeout：deadline 在 generate 在途时触发 → aborted 终态 + 超时文案 + 遮蔽 + 回滚', { timeout: 10_000 }, async () => {
    fake.setScript([{ type: 'text', content: '慢响应', delayMs: 800 }])
    const ud = setup()
    await assertExit(
      'exit-timeout-gen',
      ud,
      (msg) => expect(msg).toBe('对话超时（超过 30 分钟），已停止'),
      'aborted',
      { deadlineMs: 40 },
    )
  })

  it('① timeout：deadline 在确认闸等待期间触发（轮首中止 + timedOut）→ 同 timeout 口径', { timeout: 10_000 }, async () => {
    fake.setScript([{ type: 'tool', name: 'move_chapter', input: { chapter: 1, to: 2 } }])
    const ud = setup()
    const events: DriverEvent[] = []
    await runChat({
      driver: makeDriver(events),
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'exit-timeout-confirm',
      message: '出口走查',
      confirmTimeoutMs: 8000,
      deadlineMs: 120,
    })
    const err = events.find((e) => e.type === 'chat_error') as { error: string } | undefined
    expect(err?.error).toBe('对话超时（超过 30 分钟），已停止')
    const store = openSessionStore(ud, bookRoot)!
    try {
      const evs = store.listEvents('exit-timeout-confirm')
      expect((evs.find((e) => e.type === 'session/end') as { data: { reason: string } } | undefined)?.data.reason).toBe('aborted')
      // M-6（第十一轮）：deadline 触发的 abort 放行确认闸 → 工具结果归因「确认超时」而非
      // 「作者取消了该操作」（P5-AI·第七轮只修确认闸自身超时，deadline 场景漏——瞬时归因误导）
      const toolResult = evs.find((e) => e.type === 'tool/result') as { data: { content: string } } | undefined
      expect(toolResult?.data.content).toBe('确认超时，本次操作未执行（可重发指令）。')
    } finally {
      store.close()
    }
  })

  it('② interrupted：确认闸挂起时用户 abortChat → interrupted 终态 + 已中断文案 + 遮蔽 + 回滚', { timeout: 10_000 }, async () => {
    fake.setScript([{ type: 'tool', name: 'move_chapter', input: { chapter: 1, to: 2 } }])
    const ud = setup()
    const events: DriverEvent[] = []
    const p = runChat({
      driver: makeDriver(events),
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'exit-interrupted',
      message: '出口走查',
      confirmTimeoutMs: 8000,
    })
    // 工具挂起确认闸（此时未 abort、未超时）→ 用户中断 → waitConfirm 放行取消 → 轮首中止
    await waitFor(() => events.some((e) => e.type === 'chat_tool_pending'))
    abortChat('exit-interrupted')
    await p

    const err = events.find((e) => e.type === 'chat_error') as { error: string } | undefined
    expect(err?.error).toBe('已中断')
    const store = openSessionStore(ud, bookRoot)!
    try {
      const evs = store.listEvents('exit-interrupted')
      expect((evs.find((e) => e.type === 'session/end') as { data: { reason: string } } | undefined)?.data.reason).toBe('interrupted')
      const userSeq = (evs.find((e) => e.type === 'user/message') as ChatEvent | undefined)?.seq
      expect(
        evs.some(
          (e) =>
            e.type === 'compaction/end' &&
            e.shadowStart !== undefined &&
            e.shadowEnd !== undefined &&
            e.shadowStart <= userSeq! &&
            userSeq! <= e.shadowEnd,
        ),
      ).toBe(true)
    } finally {
      store.close()
    }
    expect(getHistory('exit-interrupted').length).toBe(0)
  })

  it('⑤ error：provider 400 → error 终态 + 错误透传文案 + 遮蔽 + 回滚', { timeout: 10_000 }, async () => {
    fake.setScript([{ type: 'error', status: 400, message: 'boom-exitwalk' }])
    const ud = setup()
    await assertExit(
      'exit-error',
      ud,
      (msg) => expect(msg).toContain('OpenAI API 400'),
      'error',
    )
  })

  it('⑥ max-tokens：截断保护 → max-tokens 终态 + 固定文案 + 遮蔽 + 回滚', { timeout: 10_000 }, async () => {
    fake.setScript([{ type: 'max_tokens', partial: '半截回复' }])
    const ud = setup()
    await assertExit(
      'exit-max-tokens',
      ud,
      (msg) => expect(msg).toBe('回复达到长度上限被截断，请缩小问题范围重试'),
      'max-tokens',
    )
  })

  it('对照：正常完成 → completed 终态、无遮蔽、历史保留（出口口径不误伤成功路径）', { timeout: 10_000 }, async () => {
    fake.setScript([{ type: 'text', content: '正常回复。' }])
    const ud = setup()
    const events: DriverEvent[] = []
    await runChat({
      driver: makeDriver(events),
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'exit-success',
      message: '出口走查',
    })
    expect(events.some((e) => e.type === 'chat_done')).toBe(true)
    expect(events.some((e) => e.type === 'chat_error')).toBe(false)
    const store = openSessionStore(ud, bookRoot)!
    try {
      const evs = store.listEvents('exit-success')
      expect((evs.find((e) => e.type === 'session/end') as { data: { reason: string } } | undefined)?.data.reason).toBe('completed')
      expect(evs.some((e) => e.type === 'compaction/end')).toBe(false)
    } finally {
      store.close()
    }
    expect(getHistory('exit-success').length).toBe(2)
  })

  // ── M-1（第十一轮）：回合 commit 点 flush 异常收编 finishTurn ──────────

  it('M-1：flush 抛错（磁盘满/血缘越界模拟）→ 收编失败出口：回滚 + 遮蔽 + chat_error，不留内存/库分裂', { timeout: 10_000 }, async () => {
    fake.setScript([{ type: 'text', content: '正常回复，但落库时炸。' }])
    const ud = setup()
    const events: DriverEvent[] = []
    // 首次 flush（无工具完成路径的回合 commit 点）抛错一次；closeMaskingAll 内部的
    // 第二次 flush 走原实现——遮蔽链本身健康时可正常收口（回滚 + 遮蔽 + 文案三件齐）
    const spy = vi.spyOn(SessionRecorder.prototype, 'flush').mockImplementationOnce(() => {
      throw new Error('disk full (mock)')
    })
    try {
      await runChat({
        driver: makeDriver(events),
        mainSession: { id: 's1', cwd: bookRoot, closed: false },
        userDataPath: ud,
        bookRoot,
        bookName: 'exit-flush-once',
        message: '出口走查',
      })
    } finally {
      spy.mockRestore()
    }

    const err = events.find((e) => e.type === 'chat_error') as { error: string } | undefined
    expect(err?.error).toContain('事件记录落库失败')
    expect(err?.error).toContain('disk full (mock)')
    const store = openSessionStore(ud, bookRoot)!
    try {
      const evs = store.listEvents('exit-flush-once')
      // 遮蔽仍完成（closeMaskingAll 内第二次 flush 原实现成功）→ error 终态 + user 被盖
      expect((evs.find((e) => e.type === 'session/end') as { data: { reason: string } } | undefined)?.data.reason).toBe('error')
      const userSeq = (evs.find((e) => e.type === 'user/message') as ChatEvent | undefined)?.seq
      expect(userSeq).toBeDefined()
      expect(
        evs.some(
          (e) =>
            e.type === 'compaction/end' &&
            e.shadowStart !== undefined &&
            e.shadowEnd !== undefined &&
            e.shadowStart <= userSeq! &&
            userSeq! <= e.shadowEnd,
        ),
      ).toBe(true)
    } finally {
      store.close()
    }
    // 历史回滚：不留「已 push 消息驻内存而事件未落库」的铁律①破口（下次对话模型可见但不可回溯）
    expect(getHistory('exit-flush-once').length).toBe(0)
  })

  it('M-1：DB 持续故障（flush 恒抛）→ 遮蔽降级不二次抛：chat_error 仍送达、runChat 正常收尾、历史回滚', { timeout: 10_000 }, async () => {
    fake.setScript([{ type: 'text', content: '落库一直炸。' }])
    const ud = setup()
    const events: DriverEvent[] = []
    const spy = vi.spyOn(SessionRecorder.prototype, 'flush').mockImplementation(() => {
      throw new Error('db broken (mock)')
    })
    try {
      await runChat({
        driver: makeDriver(events),
        mainSession: { id: 's1', cwd: bookRoot, closed: false },
        userDataPath: ud,
        bookRoot,
        bookName: 'exit-flush-always',
        message: '出口走查',
      })
    } finally {
      spy.mockRestore()
    }

    // finishTurn 自身不得再抛（closeMaskingAll 随之抛错的场景降级留痕）——chat_error 走
    // 驱动事件而非裸异常穿到 sendChatMessage 的 .catch（那是 error 事件，非 chat_error）
    const err = events.find((e) => e.type === 'chat_error') as { error: string } | undefined
    expect(err?.error).toContain('事件记录落库失败')
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(getHistory('exit-flush-always').length).toBe(0)
  })
})
