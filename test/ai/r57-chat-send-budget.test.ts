/**
 * R57-B-1 / R57-B-2（五十七轮）回归：chat 发送预算按模型 contextWindow 显式 resolve
 * + system prompt 计入发送预算（切后复查）。
 *
 * 修复前（R55-C-1 防线的两个缺口）：
 * - B-2：发送预算硬编码 CHAT_SEND_BUDGET_POINTS = 96k——64k 窗模型的防线放行必超窗
 *   （同链 maxTokens 已按模型逐层显式 resolve，发送预算却不随窗收紧，违「默认值显式
 *   resolve」域规约）。
 * - B-1：预算只数消毒后历史，system prompt 不计入——重设定书场景 sys 可达数万码点，
 *   三因素叠加（sys 不计 + 单肥回合兜底原样发送 + shrink-prompt 无消费者）仍可 400 卡死。
 *
 * 修复后：
 * - B-2：resolveChatSendBudget(contextWindow)——已知取 min(96k, ⌊窗/2⌋)（≤ 半窗给响应
 *   留余量）；未知显式回落 96k。contextWindow 经 resolveProvider → modelConfOf 的
 *   models 行取（与 finish.ts clampCheckpointOutputTokens 同款先例）。
 * - B-1：历史可用预算 = resolved 预算 − sys 点数（下限 clamp CHAT_HISTORY_MIN_BUDGET_POINTS）；
 *   切后复查 sys + 实发历史仍超 resolved 预算 → fail-open 语义不变、warn 反映真实总量
 *   （shrink-prompt 消费者接线属 A7 单独立项，本批明确不做）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { tempUserData, withFakeProvider } from '../studio/fixtures.js'
import { runAgentTurns } from '../../src/ai/orchestrate/chat/turns.js'
import {
  measureHistoryPoints,
  measureTextPoints,
  resolveChatSendBudget,
  CHAT_HISTORY_MIN_BUDGET_POINTS,
  CHAT_SEND_BUDGET_POINTS,
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
      bookName: 'r57-budget',
    },
    state: { ctrl: new AbortController(), deadline: Date.now() + 60_000, pending: new Map() },
    confirmTimeout: 1_000,
    history,
    baseLen: history.length,
    recorder: new SessionRecorder(null, 'r57-budget-session'),
    sys,
    turnBranch: undefined,
    digests: { settings: 'r57-budget-digest' },
    promptFiles: [],
    revisionPath: undefined,
    seqs: { msgSeqs: [] as number[][], pendingMsgSeqs: [] as Array<number | number[]>, commitPendingMsgSeqs: () => {} },
    markCompleted: () => {},
  }
}

function makeBookRoot(): string {
  // bookRoot 仅作 trace/记账定位（不读写书籍数据），空目录即可
  const d = mkdtempSync(join(tmpdir(), 'r57-budget-book-'))
  dirs.push(d)
  return d
}

/**
 * 带 contextWindow 模型行的 providers.json（仿 studio/fixtures withFakeProvider，
 * 增补 models 行）——contextWindow 沿 P9 模型行（provider/types.ts ModelConf）声明。
 * contextWindow 传 undefined = 不写模型行（窗口未知，走显式回退路径）。
 */
function withFakeProviderWindow(ud: string, fakeUrl: string, contextWindow: number | undefined): void {
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
        ...(contextWindow !== undefined ? { models: [{ id: 'fake-model', name: 'fake', contextWindow }] } : {}),
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

/** 肥回合历史：turns 个回合各带 big 码点 tool_result——纯文本 user 边界 u0..u(n-1)
 *  （u0 在首条不构成可切边界），结构与 r55 fatHistory 同形（保尾语义锚定同一口径） */
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

interface WireMsg {
  role: string
  content?: unknown
}

describe('R57-B-2: resolveChatSendBudget 显式 resolve（含 fallback 声明）', () => {
  it('窗口未知/非法 → 显式回落 CHAT_SEND_BUDGET_POINTS（96k，R55-C-1 校准值）', () => {
    expect(CHAT_SEND_BUDGET_POINTS).toBe(96_000)
    expect(resolveChatSendBudget(undefined)).toBe(96_000)
    expect(resolveChatSendBudget(0)).toBe(96_000)
    expect(resolveChatSendBudget(-5)).toBe(96_000)
    expect(resolveChatSendBudget(Number.NaN)).toBe(96_000)
    expect(resolveChatSendBudget(Number.POSITIVE_INFINITY)).toBe(96_000)
  })

  it('窗口已知 → min(96k, ⌊窗/2⌋)：64k 窗收紧到 32k（≤ 半窗给响应留余量）', () => {
    expect(resolveChatSendBudget(64_000)).toBe(32_000)
    expect(resolveChatSendBudget(65_536)).toBe(32_768) // 奇数窗向下取整
  })

  it('超大窗不放大（min 封顶 96k）：128k → 64k、200k/1M → 96k', () => {
    expect(resolveChatSendBudget(128_000)).toBe(64_000)
    expect(resolveChatSendBudget(192_001)).toBe(96_000)
    expect(resolveChatSendBudget(1_000_000)).toBe(96_000)
  })
})

describe('R57-B-1: 历史可用预算的下限与同族计量', () => {
  it('CHAT_HISTORY_MIN_BUDGET_POINTS 具名下限 = 20000（与 TRIM_TAIL_BUDGET_POINTS 同量级）', () => {
    expect(CHAT_HISTORY_MIN_BUDGET_POINTS).toBe(20_000)
  })

  it('measureTextPoints 与 measurePoints 文本分支同族（码点口径，代理对按 1 计）', () => {
    expect(measureTextPoints('设'.repeat(3))).toBe(3)
    expect(measureTextPoints('a👍b')).toBe(3)
    expect(measureTextPoints('')).toBe(0)
  })
})

describe('R57-B-2: 发送预算按模型 contextWindow 显式 resolve（全链路）', () => {
  it('64k 窗模型行 → 预算收紧到半窗 32k：预切点比旧硬编码 96k 显著保尾（u3 而非 u1）', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProviderWindow(ud, fake.url, 64_000)
    const bookRoot = makeBookRoot()
    // 4 回合 × 3 万码点 tool_result = 120272 码点（与 r55 同形）：旧 96k 预算切在 u1
    //（保尾 90204），新 32k 预算（半窗 − sys 3 码点 = 历史可用 31997）切在 u3（30068）
    const msgs = fatHistory(30_000, 4)
    expect(measureHistoryPoints(msgs)).toBe(120_272)
    const sent = msgs.slice()

    const ok = await runAgentTurns(makeDeps(ud, bookRoot, msgs, 'SYS'))
    expect(ok).toBe(true)

    const body = fake.lastBody() as { messages?: WireMsg[] }
    const convo = (body.messages ?? []).slice(1)
    expect(convo[0]).toEqual({ role: 'user', content: 'u3' }) // 修复前切在 u1（96k 旧预算）
    expect(convo.length).toBe(4) // u3 + 末回合 3 条
    // warn 反映 resolved 预算（32000）而非硬编码 96000
    expect(warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('发送前体量防线') && String(c[1]).includes('超发送预算 32000'))).toBe(true)
    // 32k 预算下切后总量（sys 3 + 30068）在预算内 → 无切后复查 warn
    expect(warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('切后复查'))).toBe(false)
    expect(convo.length).toBeLessThan(sent.length)
  })
})

describe('R57-B-1: system prompt 计入发送预算', () => {
  it('sys 计入预算：历史本身在旧 96k 预算内、sys+历史超预算 → 预切触发（修复前静默全发）', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url) // 无模型行 → 窗口未知 → 显式回落 96k
    const bookRoot = makeBookRoot()
    // sys 7 万码点 + 历史 40272 码点：旧口径历史 < 96k 不切、sys 不计 → 静默发 11 万码点；
    // 新口径历史可用 = 96000 − 70000 = 26000 → 保尾切在 u2（20136 ≤ 26000）
    const msgs = fatHistory(10_000, 4)
    expect(measureHistoryPoints(msgs)).toBe(40_272)
    const sys = '设'.repeat(70_000)

    const ok = await runAgentTurns(makeDeps(ud, bookRoot, msgs, sys))
    expect(ok).toBe(true)

    const body = fake.lastBody() as { messages?: WireMsg[] }
    const convo = (body.messages ?? []).slice(1)
    expect(convo[0]).toEqual({ role: 'user', content: 'u2' }) // 修复前不切（u0 全量 16 条）
    expect(convo.length).toBe(8) // u2 + 回合2(3) + u3 + 回合3(3)
    // warn 反映 sys 计入后的差额口径
    expect(warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('发送前体量防线') && String(c[1]).includes('历史可用 26000'))).toBe(true)
    // 切后 sys + 实发历史 = 70000 + 20136 = 90136 ≤ 96000 → 无切后复查 warn
    expect(warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('切后复查'))).toBe(false)
  })

  it('sys 挤穿预算 clamp 到下限：单肥回合兜底保最近一整回合，切后复查 warn 反映含 sys 真实总量', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    const bookRoot = makeBookRoot()
    // sys 8 万码点 → 历史可用 = max(20000, 96000 − 80000) = 20000；3 回合 × 3 万码点
    // （总 90204，旧口径 < 96k 不切）：所有边界保尾都超 2 万下限 → 保最近一整回合
    //（切在 u2，30068 码点）；切后总量 80000 + 30068 = 110068 > 96000 → 切后复查 warn
    const msgs = fatHistory(30_000, 3)
    expect(measureHistoryPoints(msgs)).toBe(90_204)
    const sys = '设'.repeat(80_000)

    const ok = await runAgentTurns(makeDeps(ud, bookRoot, msgs, sys))
    expect(ok).toBe(true)

    const body = fake.lastBody() as { messages?: WireMsg[] }
    const convo = (body.messages ?? []).slice(1)
    expect(convo[0]).toEqual({ role: 'user', content: 'u2' }) // 保最近一整回合（修复前 u0 全量 12 条）
    expect(convo.length).toBe(4) // u2 + 末回合 3 条
    expect(
      warnSpy.mock.calls.some(
        (c) => String(c[1] ?? '').includes('切后复查') && String(c[1]).includes('110068') && String(c[1]).includes('96000'),
      ),
    ).toBe(true) // fail-open 语义不变，warn 反映含 sys 真实总量（修复前无任何 warn）
  })

  it('历史在预算内但 sys+历史超预算：不切、原样发送，切后复查 warn 兜住漏网形态', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    const bookRoot = makeBookRoot()
    // sys 10 万码点 > resolved 预算 96k 本身：历史可用 clamp 到下限 20000，历史 2 码点
    // （问+答）在预算内不切；总量 100000 + 2 = 100002 > 96000 只能被切后复查 warn 兜住
    //（旧口径 sys 不计、零 warn）
    const msgs: ChatMsg[] = [
      { role: 'user', content: '问' },
      { role: 'assistant', content: '答' },
    ]
    const sys = '设'.repeat(100_000)

    const ok = await runAgentTurns(makeDeps(ud, bookRoot, msgs, sys))
    expect(ok).toBe(true)

    const body = fake.lastBody() as { messages?: WireMsg[] }
    const convo = (body.messages ?? []).slice(1)
    expect(convo.length).toBe(2) // 历史在预算内：原样发送（fail-open 语义不变）
    expect(convo[0]).toEqual({ role: 'user', content: '问' })
    expect(
      warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('切后复查') && String(c[1]).includes('100002')),
    ).toBe(true) // 修复前 sys 不计预算、零 warn 静默发 10 万码点 sys
  })
})
