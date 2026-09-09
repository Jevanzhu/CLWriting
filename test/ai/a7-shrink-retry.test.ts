/**
 * A7 最小版（2026-09-09 清偿批）：shrink-prompt 消费者接线回归——chat 编排层超窗收缩重试。
 *
 * 评审 P2-4（全量代码重审 2026-09-09 §5.2）：failure.ts 决策表 CONTEXT_WINDOW_EXCEEDED →
 * 'shrink-prompt' 在 A7 接线前无消费者；R55-C-1 预切 + R57-B-1 切后复查是 fail-open 静态
 * 防线，越线后（sys 超大挤到下限 / 单肥回合 / 零边界 / 码点≈token 估计误差）provider 回
 * 400 → runTask 终态失败 → 会话卡死只能人工清历史。
 *
 * 接线后行为（turns.ts 主模型发送处，重试恰一次）：
 * - ① 首发超窗 400 → 按更紧预算（⌊首发历史预算/2⌋）保尾重切 → 重算指纹 → 重发 →
 *   会话正常收尾；第二次请求载荷确实更小；llm/retry 留痕在库；两次 llm/call 的
 *   promptMeta 指纹各对齐各自实发载荷（保尾切点下末条消息不变 → 指纹恒同是正确对齐）。
 * - ② 两发都超窗 → 终态失败，错误面与现行（未接线）完全一致；恰一次重试（4 个 HTTP 请求
 *   = 2 次发送 × openai 适配器 400 降级链 2 个参数面）。
 * - ③ 非超窗 400（BAD_REQUEST）→ 不触发收缩重试（现行行为零变更）。
 *
 * 载荷形态：以「轮循环第 2 轮在途」（历史末尾悬置 tool_result）的肥历史驱动——这是
 * budgetTailCut 保尾切点真正移动、且不触发发送前预切（总量在首发预算内、因估计误差
 * 超窗）的形态；openai 适配器 400 降级链（剥 tools 重试）由 fake 脚本逐请求喂 400 驱满。
 */
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { tempUserData, withFakeProvider } from '../studio/fixtures.js'
import { runAgentTurns, lastMessageFingerprint } from '../../src/ai/orchestrate/chat/turns.js'
import { measureHistoryPoints } from '../../src/ai/prompts/chat.js'
import { chatTools } from '../../src/ai/contract/chat.js'
import { promptMeta } from '../../src/ai/trace.js'
import { SessionRecorder } from '../../src/events/chat-bridge.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { log } from '../../src/log/index.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'
import type { StudioDriver, DriverEvent, Session } from '../../src/driver/types.js'

const OVER_MSG = 'prompt is too long: 60198 tokens > 47998 maximum'

let fake: FakeProvider
const dirs: string[] = []

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  vi.restoreAllMocks()
  delete process.env.CLWRITING_DRIVER
})

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

/** 轮循环第 2 轮在途的肥历史（60198 码点，无模型行 → sendBudget 96k、首发预算 95997）：
 *  [u0, t0use, t0res(2 万), a0, u1, t1use, t1res(2 万), t2use, t2res(2 万)]——
 *  纯文本 user 边界仅 u1@4（suffix 40130）；总量在首发预算内 → 发送前预切不触发，
 *  首发原样发送（估计误差超窗形态）；重试预算 ⌊95997/2⌋=47998 → 保尾重切在 u1。 */
function inflightFatHistory(): ChatMsg[] {
  const BIG = 'X'.repeat(20_000)
  return [
    { role: 'user', content: 'u0' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', content: BIG }] },
    { role: 'assistant', content: 'a0' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: BIG }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 't2', content: BIG }] },
  ]
}

interface Setup {
  ud: string
  bookRoot: string
  emitted: DriverEvent[]
  deps: Parameters<typeof runAgentTurns>[0]
  close: () => void
}

function setup(history: ChatMsg[], script: Parameters<FakeProvider['setScript']>[number]): Setup {
  fake.setScript(script)
  const ud = tempUserData()
  dirs.push(ud)
  withFakeProvider(ud, fake.url) // 无模型行 → 窗口未知 → sendBudget 显式回落 96k
  const bookRoot = mkdtempSync(join(tmpdir(), 'a7-shrink-book-'))
  dirs.push(bookRoot)
  const emitted: DriverEvent[] = []
  // 库承载 recorder（留痕断言需要真库；与 chat.ts 同构：createSession + SessionRecorder）
  const store = openSessionStore(ud, bookRoot)!
  const sessionId = store.createSession('a7-shrink', { book: 'a7-shrink' })
  const recorder = new SessionRecorder(store, sessionId)
  const deps = {
    opts: {
      driver: makeDriver(emitted),
      mainSession: { id: 's1', cwd: bookRoot, closed: false } as Session,
      userDataPath: ud,
      bookRoot,
      bookName: 'a7-shrink',
    },
    state: { ctrl: new AbortController(), deadline: Date.now() + 60_000, pending: new Map() },
    confirmTimeout: 1_000,
    history,
    baseLen: history.length,
    recorder,
    sys: 'SYS',
    turnBranch: undefined,
    digests: { settings: 'a7-shrink-digest' },
    promptFiles: [],
    revisionPath: undefined,
    seqs: { msgSeqs: [] as number[][], pendingMsgSeqs: [] as Array<number | number[]>, commitPendingMsgSeqs: () => {} },
    markCompleted: () => {},
  }
  return {
    ud,
    bookRoot,
    emitted,
    deps: deps as unknown as Parameters<typeof runAgentTurns>[0],
    close: () => {
      recorder.dispose()
      store.close()
    },
  }
}

function readChainEvents(ud: string, bookRoot: string): Array<Record<string, unknown> & { type: string; data: Record<string, unknown> }> {
  const store = openSessionStore(ud, bookRoot)!
  try {
    return store.listEvents(bookHash(bookRoot)) as unknown as Array<Record<string, unknown> & { type: string; data: Record<string, unknown> }>
  } finally {
    store.close()
  }
}

function readChatEvents(ud: string, bookRoot: string): Array<Record<string, unknown> & { type: string; data: Record<string, unknown> }> {
  const store = openSessionStore(ud, bookRoot)!
  try {
    return store.listEvents('a7-shrink') as unknown as Array<Record<string, unknown> & { type: string; data: Record<string, unknown> }>
  } finally {
    store.close()
  }
}

describe('A7 最小版：chat 编排层 shrink-prompt 收缩重试', () => {
  it('① 首发超窗 400 → 收缩重试成功：会话正常收尾、二发载荷更小、llm/retry 留痕、指纹对齐实发', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const history = inflightFatHistory()
    // 夹具数学守卫：60198 码点 / 首发预算内（预切不触发）/ 重试预算 47998 切在 u1
    expect(measureHistoryPoints(history)).toBe(60_198)
    // 指纹期望值先于运行取——成功路径会把 assistant 回复 push 进 history（末条改变）
    const fingerprintBeforeRun = lastMessageFingerprint(history)
    const s = setup(history, [
      { type: 'error', status: 400, message: OVER_MSG },
      { type: 'error', status: 400, message: OVER_MSG },
      { type: 'text', content: '收缩后回复。', usage: { input: 100, output: 50 } },
    ])
    try {
      const ok = await runAgentTurns(s.deps)
      expect(ok).toBe(true) // 会话正常收尾（修复前：终态失败卡死）

      // 恰 3 个 HTTP 请求：首发 2 个（openai 降级链两参数面各一 400）+ 重试首发 1 个（200）
      expect(fake.requestCount()).toBe(3)
      // 第二次请求载荷确实更小：保尾重切在 u1（5 条），修复前首发为全量 9 条
      const body = fake.lastBody() as { messages?: Array<{ role: string; content?: unknown }> }
      const convo = (body.messages ?? []).slice(1) // 去掉 system
      expect(convo.length).toBe(5)
      expect(convo[0]).toEqual({ role: 'user', content: 'u1' })

      // 留痕：chat 会话库 llm/retry（复用 runner 重试留痕形态；收缩重试无退避 delayMs=0）
      const retryEvs = readChatEvents(s.ud, s.bookRoot).filter((e) => e.type === 'llm/retry')
      expect(retryEvs.length).toBe(1)
      expect(retryEvs[0]!.data).toMatchObject({ attempt: 1, delayMs: 0, errCode: 'CONTEXT_WINDOW_EXCEEDED' })

      // 指纹闭环：两次 llm/call 的 promptMeta 各对齐各自实发载荷——保尾切点下末条消息
      // 不变（末条 tool_result 悬置块），故两次指纹恒同；断言其等于按实发末条重算值
      const calls = readChainEvents(s.ud, s.bookRoot).filter((e) => e.type === 'llm/call')
      expect(calls.length).toBe(2)
      const tools = chatTools.map((t) => t.name)
      const expectedHash = promptMeta('SYS', fingerprintBeforeRun, [], tools).hash
      expect(calls[0]!.data.ok).toBe(false)
      expect(calls[0]!.data.errCode).toBe('CONTEXT_WINDOW_EXCEEDED')
      expect((calls[0]!.data.promptMeta as { hash: string }).hash).toBe(expectedHash)
      expect(calls[1]!.data.ok).toBe(true)
      expect((calls[1]!.data.promptMeta as { hash: string }).hash).toBe(expectedHash)

      // 留痕：log.warn 带前后码点数；用户面 warning + 正常 done、无 error
      expect(
        warnSpy.mock.calls.some(
          (c) => String(c[1] ?? '').includes('收缩重试') && String(c[1]).includes('60198') && String(c[1]).includes('40130'),
        ),
      ).toBe(true)
      expect(s.emitted.some((e) => e.type === 'warning' && String((e as { message?: string }).message ?? '').includes('收缩'))).toBe(true)
      expect(s.emitted.some((e) => e.type === 'chat_done')).toBe(true)
      expect(s.emitted.some((e) => e.type === 'chat_error')).toBe(false)
    } finally {
      s.close()
    }
  })

  it('② 两发都超窗 → 终态失败与现行错误面一致、重试恰一次', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const history = inflightFatHistory()
    const s = setup(history, [{ type: 'error', status: 400, message: OVER_MSG }]) // 脚本用尽后重复最后一条
    try {
      const ok = await runAgentTurns(s.deps)
      expect(ok).toBe(false)

      // 恰一次收缩重试：2 次发送 × 降级链 2 请求 = 4（修复前 2）
      expect(fake.requestCount()).toBe(4)
      // 错误面与现行（未接线）一致：provider 400 原文透传（chat-exits ⑤ 同款口径）
      const err = s.emitted.find((e) => e.type === 'chat_error') as { error: string } | undefined
      expect(err?.error).toContain(OVER_MSG)
      expect(err?.error).toContain('OpenAI API 400')
      // 历史回滚到 baseLen（失败出口语义零变更）
      expect(history.length).toBe(9)
      // 留痕：一次收缩重试 + 两条超窗 llm/call
      expect(readChatEvents(s.ud, s.bookRoot).filter((e) => e.type === 'llm/retry').length).toBe(1)
      const calls = readChainEvents(s.ud, s.bookRoot).filter((e) => e.type === 'llm/call')
      expect(calls.length).toBe(2)
      expect(calls.every((c) => c.data.ok === false && c.data.errCode === 'CONTEXT_WINDOW_EXCEEDED')).toBe(true)
      expect(
        warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('收缩重试') && String(c[1]).includes('重试后仍超窗')),
      ).toBe(true)
    } finally {
      s.close()
    }
  })

  it('③ 非超窗 400（BAD_REQUEST）→ 不触发收缩重试（现行行为零变更）', async () => {
    const history = inflightFatHistory()
    const s = setup(history, [{ type: 'error', status: 400, message: 'invalid context id: abc' }])
    try {
      const ok = await runAgentTurns(s.deps)
      expect(ok).toBe(false)

      // 仅首发降级链 2 请求，无第二次发送
      expect(fake.requestCount()).toBe(2)
      const err = s.emitted.find((e) => e.type === 'chat_error') as { error: string } | undefined
      expect(err?.error).toContain('OpenAI API 400')
      expect(err?.error).toContain('invalid context id: abc')
      expect(readChatEvents(s.ud, s.bookRoot).some((e) => e.type === 'llm/retry')).toBe(false)
      const calls = readChainEvents(s.ud, s.bookRoot).filter((e) => e.type === 'llm/call')
      expect(calls.length).toBe(1)
      expect(calls[0]!.data.errCode).toBe('BAD_REQUEST')
    } finally {
      s.close()
    }
  })
})
