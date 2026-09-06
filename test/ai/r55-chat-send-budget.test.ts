/**
 * R55-C-1（五十五轮）回归：chat 单轮发送前体量防线（按码点预算保尾预切）。
 *
 * 修复前：每轮发送全量 sanitizeHistory(history)，trimHistory/compaction 只在成功收尾
 * 后的 finalizeHistory 执行——重工具会话（大 tool_result 多轮累积）单轮发送前无任何
 * 体量闸，可撑到超窗 → provider 400（CONTEXT_WINDOW_EXCEEDED）后无自动恢复
 * （failure.ts 决策表 shrink-prompt 动作 A7 接线前无消费者），会话卡死。
 *
 * 修复后：发送前（sanitize 之后、runTask 之前）按 CHAT_SEND_BUDGET_POINTS 对消毒后
 * 历史做保尾预切（budgetTailCut 与 trimHistory 回落分支同口径：切点只取纯文本 user
 * 边界）；promptText 指纹取预切后实际发送的 toSend 末条（指纹与实发同源）；零边界
 * 病态形态照 trimHistory 先例原样发送 + warn。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { tempUserData, withFakeProvider } from '../studio/fixtures.js'
import { runAgentTurns, lastMessageFingerprint } from '../../src/ai/orchestrate/chat/turns.js'
import { budgetTailCut, measureHistoryPoints, CHAT_SEND_BUDGET_POINTS } from '../../src/ai/prompts/chat.js'
import { promptMeta } from '../../src/ai/trace.js'
import { log } from '../../src/log/index.js'
import { SessionRecorder } from '../../src/events/chat-bridge.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'
import type { StudioDriver, DriverEvent, Session } from '../../src/driver/types.js'

let fake: FakeProvider
const dirs: string[] = []

beforeAll(async () => {
  // 文本脚本（重复末条）——runAgentTurns 单轮无工具即完成
  fake = await createFakeProvider([{ type: 'text', content: '收到，这是回复。', usage: { input: 3, output: 4 } }])
})

afterAll(async () => {
  await fake.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  vi.restoreAllMocks()
})

function makeDriver(): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(): void {},
  }
}

function makeDeps(ud: string, bookRoot: string, history: ChatMsg[]) {
  return {
    opts: {
      driver: makeDriver(),
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'r55-c1',
    },
    state: { ctrl: new AbortController(), deadline: Date.now() + 60_000, pending: new Map() },
    confirmTimeout: 1_000,
    history,
    baseLen: history.length,
    recorder: new SessionRecorder(null, 'r55-c1-session'),
    sys: '你是测试系统提示（R55-C-1 发送预算差分锚）',
    turnBranch: undefined,
    digests: { settings: 'r55-c1-digest' },
    promptFiles: [],
    revisionPath: undefined,
    seqs: { msgSeqs: [] as number[][], pendingMsgSeqs: [] as Array<number | number[]>, commitPendingMsgSeqs: () => {} },
    markCompleted: () => {},
  }
}

function makeBookRoot(): string {
  // bookRoot 仅作 trace/记账定位（不读写书籍数据），空目录即可
  const d = mkdtempSync(join(tmpdir(), 'r55-c1-book-'))
  dirs.push(d)
  return d
}

function readLlmCallHashes(ud: string, bookRoot: string): string[] {
  const store = openSessionStore(ud, bookRoot)!
  try {
    return store
      .listEvents(bookHash(bookRoot))
      .filter((e) => e.type === 'llm/call')
      .map((e) => ((e.data as { promptMeta?: { hash?: string } }).promptMeta?.hash ?? ''))
  } finally {
    store.close()
  }
}

/** 肥回合历史：4 个回合各带 3 万码点 tool_result（总 ~12 万码点 > 96k 预算），
 *  纯文本 user 边界 u1/u2/u3（u0 在首条不构成可切边界） */
function fatHistory(): ChatMsg[] {
  const BIG = 'X'.repeat(30_000)
  const turn = (n: number): ChatMsg[] => [
    { role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: `t${n}`, content: BIG }] },
    { role: 'assistant', content: `a${n}` },
  ]
  return [
    { role: 'user', content: 'u0' },
    ...turn(0),
    { role: 'user', content: 'u1' },
    ...turn(1),
    { role: 'user', content: 'u2' },
    ...turn(2),
    { role: 'user', content: 'u3' },
    ...turn(3),
  ]
}

interface WireMsg {
  role: string
  content?: unknown
  tool_calls?: unknown[]
}

describe('R55-C-1: budgetTailCut 纯函数（与 trimHistory 回落同口径）', () => {
  it('肥历史超预算 → 切点取最早可容纳的纯文本 user 边界，切后在预算内', () => {
    const msgs = fatHistory()
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
    const msgs = fatHistory()
    // runAgentTurns 正常完成路径会就地 push 收尾 assistant（同一数组引用）——
    // 发送面断言一律以 run 前快照为准
    const sent = msgs.slice()

    const deps = makeDeps(ud, bookRoot, msgs)
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
    expect(warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('发送前体量防线') && String(c[1]).includes('120272'))).toBe(true)
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

    const ok = await runAgentTurns(makeDeps(ud, bookRoot, msgs))
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

    const ok = await runAgentTurns(makeDeps(ud, bookRoot, msgs))
    expect(ok).toBe(true)

    const body = fake.lastBody() as { messages?: WireMsg[] }
    const convo = (body.messages ?? []).slice(1)
    expect(convo.length).toBe(sent.length) // 原样发送（照 trimHistory 先例不硬劈）
    expect(convo[0]).toEqual({ role: 'user', content: 'u0' })
    expect(warnSpy.mock.calls.some((c) => String(c[1] ?? '').includes('无法安全预切'))).toBe(true)
  })
})
