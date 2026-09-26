// 0918二轮修复批（A101）：小上下文模型（contextWindow < 40k）下 chat 发送体量防线回归。
// 文件头锚注：源码锚 src/ai/orchestrate/chat/turns.ts（historyBudget 下限 clamp）与
// src/ai/prompts/chat.ts（resolveChatSendBudget / CHAT_HISTORY_MIN_BUDGET_POINTS）。
//
// 修复前：historyBudget = max(20_000, sendBudget − sys) 的下限恒 20k，而 sendBudget =
// min(96k, ⌊contextWindow/2⌋) 在 16k/32k 窗的小窗模型行上 < 20k——下限被 Math.max 钉在
// 高于发送预算本身的 20k：预防线 `sendPoints > historyBudget` 对 [sendBudget, 20k] 区间
// 永不触发（实发必超窗 400），A7 收缩重试预算 ⌊20k/2⌋ = 10k 仍可高于真实窗口预算 →
// 二次 400 会话死路。
//
// 修复后：下限先与 sendBudget 取 min（随预算收缩），historyBudget 恒 ≤ sendBudget：
// ① 30k 窗（sendBudget 15k）：历史 18 204 码点落在旧防线的盲区 [15k, 20k]——修复前不切
//    全量发送，修复后保尾预切到 ≤ 15k；
// ② 16k 窗（sendBudget 8k）：超窗收缩重试预算 = ⌊historyBudget/2⌋ 随 8k 收缩到 4k，
//    不再取到 10k 这种高于实发预算本身的值（修复前 warn 自证：首发历史预算 20000 /
//    重试预算 10000，均 > 8000 的真实发送预算）。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { tempUserData } from '../studio/fixtures.js'
import { runAgentTurns } from '../../src/ai/orchestrate/chat/turns.js'
import {
  measureHistoryPoints,
  resolveChatSendBudget,
  CHAT_HISTORY_MIN_BUDGET_POINTS,
} from '../../src/ai/prompts/chat.js'
import { saveProviders, type ProviderStore } from '../../src/ai/provider/store.js'
import { log } from '../../src/log/index.js'
import { SessionRecorder } from '../../src/events/chat-bridge.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'

let fake: FakeProvider
const dirs: string[] = []

beforeAll(async () => {
  // 文本脚本（重复末条）——runAgentTurns 单轮无工具即完成；脚本用尽后重复最后一条
  fake = await createFakeProvider([{ type: 'text', content: '收到，这是回复。', usage: { input: 3, output: 4 } }])
})

afterAll(async () => {
  await fake.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  vi.restoreAllMocks()
})

function makeDeps(ud: string, bookRoot: string, history: ChatMsg[], sys: string) {
  return {
    opts: {
      driver: makeFakeDriver(),
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'a101-budget',
    },
    state: { ctrl: new AbortController(), deadline: Date.now() + 60_000, pending: new Map() },
    confirmTimeout: 1_000,
    history,
    baseLen: history.length,
    recorder: new SessionRecorder(null, 'a101-budget-session'),
    sys,
    turnBranch: undefined,
    digests: { settings: 'a101-budget-digest' },
    promptFiles: [],
    revisionPath: undefined,
    seqs: { msgSeqs: [] as number[][], pendingMsgSeqs: [] as Array<number | number[]>, commitPendingMsgSeqs: () => {} },
    markCompleted: () => {},
  }
}

function makeBookRoot(): string {
  // bookRoot 仅作 trace/记账定位（不读写书籍数据），空目录即可
  const d = mkdtempTracked(join(tmpdir(), 'a101-budget-book-'))
  dirs.push(d)
  return d
}

/** 带指定 contextWindow 模型行的 providers.json（沿 P9 模型行声明，r57 同款形态） */
function withFakeProviderWindow(ud: string, fakeUrl: string, contextWindow: number): void {
  const store: ProviderStore = {
    providers: [
      {
        id: 'fake-prov',
        name: 'fake',
        protocol: 'openai',
        auth: 'bearer',
        baseUrl: fakeUrl,
        model: 'fake-model',
        apiKey: 'sk-fake-key',
        caps: { connected: true, streaming: true },
        capsProbedAt: Date.now(),
        models: [{ id: 'fake-model', name: 'fake', contextWindow }],
      },
    ],
    currentId: 'fake-prov',
    currentModel: 'fake-model',
    modelCaps: {},
    ragProviders: [],
    tiers: { creative: { model: 'fake-model', effort: 'medium' }, assistant: null, chat: null },
    revision: 0,
    vault: null,
    dek: null,
  }
  saveProviders(ud, store)
}

/** 肥回合历史：turns 个回合各带 big 码点 tool_result，纯文本 user 边界 u1..u(n-1)
 *  （u0 在首条不构成可切边界）——结构与 r55/r57 fatHistory 同形（保尾语义锚定同一口径） */
function fatHistory(big: number, turns: number): ChatMsg[] {
  const BIG = 'X'.repeat(big)
  const turn = (n: number): ChatMsg[] => [
    { role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: `t${n}`, content: BIG }] },
    { role: 'assistant', content: `a${n}` },
  ]
  const msgs: ChatMsg[] = [{ role: 'user', content: 'u0' }]
  for (let n = 0; n < turns; n++) {
    if (n > 0) msgs.push({ role: 'user', content: `u${n}` })
    msgs.push(...turn(n))
  }
  return msgs
}

/** 轮循环第 2 轮在途的肥历史（a7-shrink-retry 同形缩小版）：纯文本 user 边界仅 u1@4，
 *  单肥回合兜底使收缩重试在任一重试预算下都保尾切在 u1（5 条） */
function inflightFatHistory(): ChatMsg[] {
  const BIG = 'X'.repeat(2_000)
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

interface WireMsg {
  role: string
  content?: unknown
}

describe('A101: 小上下文模型下 historyBudget 下限随预算收缩', () => {
  it('夹具数学守卫：30k 窗 sendBudget 15k < 下限 20k——正是修复前防线盲区的构成条件', () => {
    expect(resolveChatSendBudget(30_000)).toBe(15_000)
    expect(resolveChatSendBudget(16_000)).toBe(8_000)
    expect(resolveChatSendBudget(30_000)).toBeLessThan(CHAT_HISTORY_MIN_BUDGET_POINTS)
  })

  it('30k 窗：历史 18204 码点落在盲区 [15k, 20k] → 保尾预切到 ≤ 15k（修复前 20k 下限不切、全量发送）', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProviderWindow(ud, fake.url, 30_000)
    const bookRoot = makeBookRoot()
    // 3 回合 × 6000 码点 tool_result：总 18204 码点——修复前 historyBudget = max(20000,
    // 14997) = 20000 ≥ 18204 → 预防线不触发、全量 12 条发送（实发 18204 > 15000 必超窗）；
    // 修复后 historyBudget = max(min(20000, 15000), 14997) = 15000 → 保尾切在 u1（12136 ≤ 15000）
    const msgs = fatHistory(6_000, 3)
    expect(measureHistoryPoints(msgs)).toBe(18_204)

    const ok = await runAgentTurns(makeDeps(ud, bookRoot, msgs, 'SYS'))
    expect(ok).toBe(true)

    const body = fake.lastBody() as { messages?: WireMsg[] }
    const convo = (body.messages ?? []).slice(1)
    // 修复后：切在 u1，实发 8 条 12136 码点（≤ sendBudget 15000）；修复前全量 12 条
    expect(convo[0]).toEqual({ role: 'user', content: 'u1' })
    expect(convo.length).toBe(8)
    const convoMsgs: ChatMsg[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'X'.repeat(6_000) }] },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't2', content: 'X'.repeat(6_000) }] },
      { role: 'assistant', content: 'a2' },
    ]
    expect(measureHistoryPoints(convoMsgs)).toBe(12_136)
    expect(measureHistoryPoints(convoMsgs)).toBeLessThanOrEqual(15_000)
    // 预防线 warn 反映收缩后的真实预算（修复前零 warn——防线未触发即静默超窗）
    expect(
      warnSpy.mock.calls.some(
        (c) => String(c[1] ?? '').includes('发送前体量防线') && String(c[1]).includes('超发送预算 15000'),
      ),
    ).toBe(true)
    // 切后总量（sys 3 + 12136）在预算内 → 无切后复查 warn（fail-open 语义不变）
    expect(warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('切后复查'))).toBe(false)
  })

  it('16k 窗：超窗收缩重试预算随 8k 收缩到 4k，不再取到高于实发预算的 10k（修复前 ⌊20k/2⌋=10k > sendBudget 8k）', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProviderWindow(ud, fake.url, 16_000)
    const bookRoot = makeBookRoot()
    // 6198 码点在修复后首发预算 8000 内（预切不触发，脚本 400 模拟估计误差超窗形态）；
    // 修复前 historyBudget = 20000：首发同样不切，但收缩重试预算 ⌊20000/2⌋ = 10000
    // 高于 sendBudget 8000 本身（重试载荷仍可超窗 → 二次 400 死路）
    const history = inflightFatHistory()
    expect(measureHistoryPoints(history)).toBe(6_198)
    fake.setScript([
      { type: 'error', status: 400, message: 'prompt is too long: 6198 tokens > 4000 maximum' },
      { type: 'text', content: '收缩后回复。', usage: { input: 100, output: 50 } },
    ])

    const ok = await runAgentTurns(makeDeps(ud, bookRoot, history, 'SYS'))
    expect(ok).toBe(true)

    // 恰 2 个 HTTP 请求：首发 400 + 收缩重试 200
    expect(fake.requestCount()).toBe(2)
    // 重试载荷保尾切在 u1（5 条，修复前后切点同——差异在预算数值与载荷是否仍可能超窗）
    const body = fake.lastBody() as { messages?: WireMsg[] }
    const convo = (body.messages ?? []).slice(1)
    expect(convo.length).toBe(5)
    expect(convo[0]).toEqual({ role: 'user', content: 'u1' })
    // 核心断言：收缩重试预算 = ⌊historyBudget/2⌋ 随收缩后的 8000 取半（4000），
    // 首发历史预算 = 8000（≤ sendBudget）；修复前 warn 自证 20000/10000（> 8000）
    expect(
      warnSpy.mock.calls.some(
        (c) => String(c[1] ?? '').includes('首发历史预算 8000') && String(c[1]).includes('重试预算 4000'),
      ),
    ).toBe(true)
    expect(warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('首发历史预算 20000'))).toBe(false)
    expect(warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('重试预算 10000'))).toBe(false)
  })
})
