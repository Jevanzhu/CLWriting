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
 *
 * 2026-09-26 终扫自 r1010b-chat-timeout-copy.test.ts 并入（R1010b-AI-P3-3：超时文案按
 * 实际生效 deadline 换算）——finishTurn 单元臂收编于文末（注入换算 / 45s→1 分钟
 * 四舍五入 / 缺省 30 分钟三形态；与 runChat 层 ④① 的文案断言互补，零断言去重）。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat, abortChat, getHistory } from '../../src/ai/orchestrate/chat.js'
import { finishTurn } from '../../src/ai/orchestrate/chat/finish.js'
import type { ChatOpts } from '../../src/ai/orchestrate/chat.js'
import { loadProviders, saveProviders } from '../../src/ai/provider/store.js'
import { SessionRecorder } from '../../src/events/chat-bridge.js'
import { openSessionStore } from '../../src/events/store.js'
import type { DriverEvent } from '../../src/driver/types.js'
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

import { waitFor } from '../helpers/wait-for.js'

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
    driver: makeFakeDriver({ emitted: events }),
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
  // 0918三拍板批（A006 轻量档）：非 regenerate 失败出口随 chat_error 回显作者原文
  //（本走查恒走 message 路径）——回滚/遮蔽四件套语义不变，原文仅存于事件供复制重发
  expect((err as { echo?: string }).echo).toBe('出口走查')

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
    // 2026-09-17 CI 复验批裕量放宽（原 40ms/800ms）：deadline 必须在 generate 起跑之后
    // 在途时触发——慢机（CI win runner 全套 24 分钟）上 40ms 可能在 generate 起跑前
    // 到期走错出口；1s/5s 保持同一形态（deadline ≪ 响应延迟），文案换算 Math.round
    // (1000/60000)=0 分钟不变，断言语义零漂移
    fake.setScript([{ type: 'text', content: '慢响应', delayMs: 5000 }])
    const ud = setup()
    await assertExit(
      'exit-timeout-gen',
      ud,
      // R1010b-AI-P3-3：文案按实际生效 deadline 换算（本测注入 deadlineMs: 1000 → 0 分钟）
      (msg) => expect(msg).toBe('对话超时（超过 0 分钟），已停止'),
      'aborted',
      { deadlineMs: 1000 },
    )
  })

  it('① timeout：deadline 在确认闸等待期间触发（轮首中止 + timedOut）→ 同 timeout 口径', { timeout: 10_000 }, async () => {
    // 2026-09-17 CI 复验批裕量放宽（原 deadlineMs: 120）：deadline 必须在工具调用挂上
    // 确认闸**之后**触发，工具才有 tool/result 可归因「确认超时」——CI win runner 上
    // 120ms 在确认闸挂起前到期 → 轮首中止时工具未执行、tool/result 缺失（实测
    // undefined 红）。2s ≪ confirmTimeoutMs 8000 维持「deadline 先赢」形态，慢机到达
    // 确认闸的实测裕量 ~4×；文案换算 Math.round(2000/60000)=0 分钟不变
    fake.setScript([{ type: 'tool', name: 'move_chapter', input: { chapter: 1, to: 2 } }])
    const ud = setup()
    const events: DriverEvent[] = []
    await runChat({
      driver: makeFakeDriver({ emitted: events }),
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'exit-timeout-confirm',
      message: '出口走查',
      confirmTimeoutMs: 8000,
      deadlineMs: 2000,
    })
    const err = events.find((e) => e.type === 'chat_error') as { error: string } | undefined
    // R1010b-AI-P3-3：文案按实际生效 deadline 换算（本测注入 deadlineMs: 2000 → 0 分钟）
    expect(err?.error).toBe('对话超时（超过 0 分钟），已停止')
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
      driver: makeFakeDriver({ emitted: events }),
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
      driver: makeFakeDriver({ emitted: events }),
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
        driver: makeFakeDriver({ emitted: events }),
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
        driver: makeFakeDriver({ emitted: events }),
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

  // ── R42-26（四十二轮）：!ok 出口终态 mask 按 out.code 分流 ─────────────
  // generate 在途的中断/档位超时此前一律落 { error }（mask 'error'），与轮首 :427 口径
  //（timeout/interrupted）失真；现 ABORTED→'interrupted'、TIMEOUT_TOTAL→'timeout'

  it('R42-26：generate 在途用户中断（out.code=ABORTED）→ interrupted 终态 + 已中断文案', { timeout: 10_000 }, async () => {
    fake.setScript([{ type: 'text', content: '慢响应', delayMs: 10_000 }])
    const ud = setup()
    const events: DriverEvent[] = []
    const p = runChat({
      driver: makeFakeDriver({ emitted: events }),
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'exit-r42-aborted',
      message: '出口走查',
    })
    // 请求已在途（generate 进行中）→ 用户中断 → runTask ABORTED → finishTurn 'interrupted'
    await waitFor(() => fake.requestCount() > 0)
    abortChat('exit-r42-aborted')
    await p

    const err = events.find((e) => e.type === 'chat_error') as { error: string } | undefined
    expect(err?.error).toBe('已中断')
    const store = openSessionStore(ud, bookRoot)!
    try {
      const evs = store.listEvents('exit-r42-aborted')
      expect((evs.find((e) => e.type === 'session/end') as { data: { reason: string } } | undefined)?.data.reason).toBe('interrupted')
    } finally {
      store.close()
    }
    expect(getHistory('exit-r42-aborted').length).toBe(0)
  })

  it('R42-26：档位超时（out.code=TIMEOUT_TOTAL）→ timeout 出口（mask aborted）+ 超时文案', { timeout: 10_000 }, async () => {
    // chat 档位带 60ms 总超时——runTask 档位超时返回 TIMEOUT_TOTAL（非 chat deadline 的
    // timedOut 路径），finishTurn 按 out.code 分流到 'timeout'
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    const s = loadProviders(ud)
    s.tiers.chat = { model: 'fake-model', effort: 'medium', timeoutMs: 60 }
    saveProviders(ud, s)

    fake.setScript([{ type: 'text', content: '慢响应', delayMs: 10_000 }])
    await assertExit(
      'exit-r42-tier-timeout',
      ud,
      (msg) => expect(msg).toBe('对话超时（超过 30 分钟），已停止'),
      'aborted', // CHAT_EXIT_SPEC.timeout 的 mask（timeout 出口终态）
    )
  })
})

// ── R1010b-AI-P3-3（2026-09-10 内存专项重审修复批）：超时文案按实际生效 deadline 换算 ──
// 修复前 CHAT_EXIT_SPEC.timeout 恒按缺省 AGENT_DEADLINE_MS（30min）换算——注入短
// deadline 的对话超时也报「超过 30 分钟」（R70-12 注释自认「文案按缺省口径展示」）。
// 修复后 finishTurn 按 opts.deadlineMs ?? AGENT_DEADLINE_MS 现算（与 chat.ts
// runChatInner 的 resolve 同式），mask 终态口径（aborted）不变。
// 上文 ④① 两用例为 runChat 层文案断言（注入 1s/2s → 0 分钟）；本节为 finishTurn
// 单元臂，补注入换算 / 分钟四舍五入 / 缺省 30 分钟三形态与 mask 三处一致断言。
describe('R1010b-AI-P3-3：超时文案按实际生效 deadline 换算（finishTurn 单元臂）', () => {
  function makeOpts(deadlineMs?: number): { opts: ChatOpts; emitted: DriverEvent[] } {
    const emitted: DriverEvent[] = []
    const opts: ChatOpts = {
      driver: makeFakeDriver({ emitted }),
      mainSession: { id: 's1', cwd: '.', closed: false },
      userDataPath: '.',
      bookRoot: '.',
      bookName: 'r1010b-timeout-copy',
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    }
    return { opts, emitted }
  }

  function chatError(emitted: DriverEvent[]): string {
    const err = emitted.find((e) => e.type === 'chat_error') as { error: string } | undefined
    expect(err).toBeDefined()
    return err!.error
  }

  it('注入 deadlineMs → 文案随注入值换算；缺省 → 恒按 30 分钟；mask 终态口径不变', () => {
    const maskSpy = vi.spyOn(SessionRecorder.prototype, 'closeMaskingAll')
    try {
      // 注入 40ms（既有注入形态）→ 按实际值换算，不再谎报 30 分钟
      const injected = makeOpts(40)
      finishTurn(injected.opts, [], 0, new SessionRecorder(null, 'r1010b-rec-1'), 'timeout')
      expect(chatError(injected.emitted)).toBe('对话超时（超过 0 分钟），已停止')

      // 分钟级注入值 → 四舍五入换算（45s → 1 分钟）
      const minute = makeOpts(45_000)
      finishTurn(minute.opts, [], 0, new SessionRecorder(null, 'r1010b-rec-2'), 'timeout')
      expect(chatError(minute.emitted)).toBe('对话超时（超过 1 分钟），已停止')

      // 缺省（生产路径）→ 30 分钟口径不变
      const def = makeOpts()
      finishTurn(def.opts, [], 0, new SessionRecorder(null, 'r1010b-rec-3'), 'timeout')
      expect(chatError(def.emitted)).toBe('对话超时（超过 30 分钟），已停止')

      // 终态 mask 三处一致（session/end 实参），参数化只动文案
      expect(maskSpy).toHaveBeenNthCalledWith(1, 'aborted')
      expect(maskSpy).toHaveBeenNthCalledWith(2, 'aborted')
      expect(maskSpy).toHaveBeenNthCalledWith(3, 'aborted')
    } finally {
      maskSpy.mockRestore()
    }
  })
})
