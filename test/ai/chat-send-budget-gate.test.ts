/**
 * chat 单轮发送前体量防线（发送预算）：按码点预算保尾预切（R55-C-1 基线）+ 预算按
 * 模型 contextWindow 显式 resolve、system prompt 计入预算（R57-B-1/B-2 补强）。
 * 两源并一案（按被测行为合并；断言逐条保留、去重 0 条——R57 是 R55 防线的两个缺口
 * 修补，预算解析/计量/预切/切后复查属同一条防线的四段，互为锚定）：
 * - r55-chat-send-budget.test.ts（R55-C-1：每轮发送全量 sanitizeHistory，trimHistory/
 *   compaction 只在收尾 finalizeHistory 执行——重工具会话单轮发送无体量闸可撑到超窗
 *   400 卡死。修复后发送前按 CHAT_SEND_BUDGET_POINTS 保尾预切（budgetTailCut 切点只取
 *   纯文本 user 边界）；promptText 指纹取预切后实际发送末条（指纹与实发同源）；零边界
 *   病态形态照 trimHistory 先例原样发送 + warn）
 * - r57-chat-send-budget.test.ts（R57-B-2：发送预算硬编码 96k——64k 窗模型防线放行必
 *   超窗；改 resolveChatSendBudget(contextWindow)=min(96k, ⌊窗/2⌋)，未知显式回落 96k。
 *   R57-B-1：预算只数历史不计 system prompt——历史可用 = resolved − sys（下限 clamp
 *   CHAT_HISTORY_MIN_BUDGET_POINTS）；切后复查超预算 → fail-open 语义不变、warn 反映
 *   含 sys 真实总量）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { tempUserData, withFakeProvider } from '../studio/fixtures.js'
import { runAgentTurns, lastMessageFingerprint } from '../../src/ai/orchestrate/chat/turns.js'
import {
  budgetTailCut,
  measureHistoryPoints,
  measureTextPoints,
  resolveChatSendBudget,
  CHAT_HISTORY_MIN_BUDGET_POINTS,
  CHAT_SEND_BUDGET_POINTS,
} from '../../src/ai/prompts/chat.js'
import { saveProviders, type ProviderStore } from '../../src/ai/provider/store.js'
import { promptMeta } from '../../src/ai/trace.js'
import { log } from '../../src/log/index.js'
import { SessionRecorder } from '../../src/events/chat-bridge.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
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
      bookName: 'chat-send-budget',
    },
    state: { ctrl: new AbortController(), deadline: Date.now() + 60_000, pending: new Map() },
    confirmTimeout: 1_000,
    history,
    baseLen: history.length,
    recorder: new SessionRecorder(null, 'chat-send-budget-session'),
    sys,
    turnBranch: undefined,
    digests: { settings: 'chat-send-budget-digest' },
    promptFiles: [],
    revisionPath: undefined,
    seqs: { msgSeqs: [] as number[][], pendingMsgSeqs: [] as Array<number | number[]>, commitPendingMsgSeqs: () => {} },
    markCompleted: () => {},
  }
}

function makeBookRoot(): string {
  // bookRoot 仅作 trace/记账定位（不读写书籍数据），空目录即可
  const d = mkdtempTracked(join(tmpdir(), 'chat-send-budget-book-'))
  dirs.push(d)
  return d
}

function readLlmCallHashes(ud: string, bookRoot: string): string[] {
  const store = openSessionStore(ud, bookRoot)!
  try {
    return store
      .listEvents(bookHash(bookRoot))
      .filter((e) => e.type === 'llm/call')
      .map((e) => (e.data as { promptMeta?: { hash?: string } }).promptMeta?.hash ?? '')
  } finally {
    store.close()
  }
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
 *  （u0 在首条不构成可切边界），保尾语义锚定同一口径 */
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
  tool_calls?: unknown[]
}

describe('R55-C-1: budgetTailCut 纯函数（与 trimHistory 回落同口径）', () => {
  it('肥历史超预算 → 切点取最早可容纳的纯文本 user 边界，切后在预算内', () => {
    const msgs = fatHistory(30_000, 4)
    // 计量口径锚定：4×30000（tool_result）+ 4×64（tool_use）+ 8×2（短文本）
    expect(measureHistoryPoints(msgs)).toBe(120_272)
    expect(measureHistoryPoints(msgs)).toBeGreaterThan(CHAT_SEND_BUDGET_POINTS)

    const cut = budgetTailCut(msgs, CHAT_SEND_BUDGET_POINTS)
    // u0 后缀 120272 > 96k；u1 后缀 90204 ≤ 96k → 切在 u1（idx 4）
    expect(cut).toBe(4)
    const kept = msgs.slice(cut!) // 上一行断言 cut=4（非 null）；! 仅为收窄 TS 类型
    expect(measureHistoryPoints(kept)).toBeLessThanOrEqual(CHAT_SEND_BUDGET_POINTS)
    expect(kept[0]).toEqual({ role: 'user', content: 'u1' }) // 切点 = 纯文本 user 边界
    expect(kept.length).toBe(msgs.length - 4)
  })

  it('任一边界保尾都超预算 → 保最近一整回合（不空手发送）', () => {
    const big = '长'.repeat(120_000)
    const msgs: ChatMsg[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', content: big }] },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: big }] },
    ]
    // 唯一可切边界 u1（idx 3）的后缀 120064 > 预算 → 仍切在该边界（保最近一整回合）
    expect(budgetTailCut(msgs, CHAT_SEND_BUDGET_POINTS)).toBe(3)
  })

  it('无任何纯文本 user 边界（病态形态）→ null（无法安全切）', () => {
    const msgs: ChatMsg[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', content: 'r' }] },
    ]
    expect(budgetTailCut(msgs, CHAT_SEND_BUDGET_POINTS)).toBeNull()
  })
})

describe('R55-C-1: runAgentTurns 发送前预切（全链路）', () => {
  it('超预算肥历史 → 预切生效：实发为保尾切片、切点不在 tool 配对中间、指纹取预切后末条、warn 留痕', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    const bookRoot = makeBookRoot()
    const msgs = fatHistory(30_000, 4)
    // runAgentTurns 正常完成路径会就地 push 收尾 assistant（同一数组引用）——
    // 发送面断言一律以 run 前快照为准
    const sent = msgs.slice()

    const deps = makeDeps(ud, bookRoot, msgs, '你是测试系统提示（R55-C-1 发送预算差分锚）')
    const ok = await runAgentTurns(deps)
    expect(ok).toBe(true)

    // 实发面：预切生效——发送条数 < 历史条数，首条对话消息是纯文本 user（u1，修复前为 u0）
    const body = fake.lastBody() as { messages?: WireMsg[] }
    const wire = body.messages ?? []
    expect(wire.length).toBeGreaterThan(0)
    expect(wire[0]!.role).toBe('system') // system prompt 独占首条
    const convo = wire.slice(1)
    expect(convo.length).toBeLessThan(sent.length)
    expect(convo[0]).toEqual({ role: 'user', content: 'u1' })
    // 切点安全泛式：每条 role:'tool' 的前一相邻消息必是带 tool_calls 的 assistant
    //（或同源 user 消息展开的连续 tool）——切点永不落在 tool_use/tool_result 配对中间
    for (let i = 1; i < convo.length; i++) {
      if (convo[i]!.role === 'tool') {
        const prev = convo[i - 1]!
        expect(prev.role === 'assistant' || prev.role === 'tool').toBe(true)
        if (prev.role === 'assistant') expect(Array.isArray(prev.tool_calls)).toBe(true)
      }
    }

    // 指纹面：llm/call promptMeta 与「预切后实际发送切片的末条」同源
    const expected = sent.slice(budgetTailCut(sent, CHAT_SEND_BUDGET_POINTS)!)
    const hashes = readLlmCallHashes(ud, bookRoot)
    expect(hashes.length).toBe(1)
    expect(hashes[0]).toBe(promptMeta(deps.sys, lastMessageFingerprint(expected)).hash)

    // warn 留痕：含前后码点数（口径：历史 X 条约 Y 码点 → 保尾预切）
    expect(
      warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('发送前体量防线') && String(c[1]).includes('120272')),
    ).toBe(true)
  })

  it('预算内历史 → no-op 不切（实发全量、无预切 warn）', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    const bookRoot = makeBookRoot()
    const msgs: ChatMsg[] = [
      { role: 'user', content: '问题一号' },
      { role: 'assistant', content: '回答一号' },
    ]
    const sent = msgs.slice()

    const ok = await runAgentTurns(makeDeps(ud, bookRoot, msgs, '你是测试系统提示（R55-C-1 发送预算差分锚）'))
    expect(ok).toBe(true)

    const body = fake.lastBody() as { messages?: WireMsg[] }
    const convo = (body.messages ?? []).slice(1)
    expect(convo.length).toBe(sent.length) // 全量发送
    expect(convo[0]).toEqual({ role: 'user', content: '问题一号' })
    expect(warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('发送前体量防线'))).toBe(false)
  })

  it('零边界病态形态（单 user 首条 + 巨型 tool_result）→ 无法安全切，原样发送 + warn', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const ud = tempUserData()
    dirs.push(ud)
    withFakeProvider(ud, fake.url)
    const bookRoot = makeBookRoot()
    const msgs: ChatMsg[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', content: 'Y'.repeat(200_000) }] },
    ]
    const sent = msgs.slice()

    const ok = await runAgentTurns(makeDeps(ud, bookRoot, msgs, '你是测试系统提示（R55-C-1 发送预算差分锚）'))
    expect(ok).toBe(true)

    const body = fake.lastBody() as { messages?: WireMsg[] }
    const convo = (body.messages ?? []).slice(1)
    expect(convo.length).toBe(sent.length) // 原样发送（照 trimHistory 先例不硬劈）
    expect(convo[0]).toEqual({ role: 'user', content: 'u0' })
    expect(warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('无法安全预切'))).toBe(true)
  })
})

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
    expect(
      warnSpy.mock.calls.some(
        (c) => String(c[1] ?? '').includes('发送前体量防线') && String(c[1]).includes('超发送预算 32000'),
      ),
    ).toBe(true)
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
    expect(
      warnSpy.mock.calls.some(
        (c) => String(c[1] ?? '').includes('发送前体量防线') && String(c[1]).includes('历史可用 26000'),
      ),
    ).toBe(true)
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
        (c) =>
          String(c[1] ?? '').includes('切后复查') && String(c[1]).includes('110068') && String(c[1]).includes('96000'),
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
