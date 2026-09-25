/**
 * R0916-7-P3-2（全项目源码质量与优雅度评审 P3-2）直测：chat 回合三段（turns-phases）。
 *
 * runAgentTurns 原为 306 行 / 圈复杂度 79 的单函数（轮首三出口 + 血缘登记 + 发送面预切 +
 * 首发与两类重试 + 出口分流 + 无工具完成面 + 工具轮全链 + 触顶收尾），本批按三段切出：
 * 阶段一 initiateAgentTurn（单轮发起）/ 阶段二 runToolTurn（工具派发与回填）/
 * 阶段三 closeAgentTurn + closeByTurnLimit（收尾与终止判定）。本用例锁三段的顺序
 * 不变量（语义锚 = 既有集成用例）：
 * ① 血缘登记先于任何发送（阶段一，发送面重、集成锚覆盖）；
 * ② history push 顺序 assistant → user(tool_result) 与派发闸序（未知工具不弹确认卡 →
 *    写风险确认闸 → 执行）；
 * ③ 失败面 mask 分流（ABORTED→interrupted / TIMEOUT_TOTAL→timeout / 其余 error）与
 *    「无工具完成面先广播后压缩」的收尾口径。
 * finalizeHistory 侧的压缩/耗时 IO 不在本用例面（flushTurnEvents 注入 false 即止步于
 * chat_done 之前/之后，见各用例注）。
 */
import { describe, expect, it } from 'vitest'
import {
  CHAT_TOOL_NAMES,
  MAX_AGENT_TURNS,
  judgeTurnTermination,
  lastMessageFingerprint,
  runToolTurn,
  closeAgentTurn,
  closeByTurnLimit,
  type ChatGeneration,
  type ChatSendOut,
  type TurnDeps,
} from '../../../src/ai/orchestrate/chat/turns-phases.js'
import { TOOL_RISK, chatTools } from '../../../src/ai/contract/chat.js'
import type { ChatOpts } from '../../../src/ai/orchestrate/chat.js'
import type { ChatRunState } from '../../../src/ai/orchestrate/chat/state.js'
import type { ChatSeqLedger } from '../../../src/ai/orchestrate/chat/restore.js'
import type { SessionRecorder } from '../../../src/events/chat-bridge.js'
import type { NewEvent } from '../../../src/events/store.js'
import type { TaskCode, TaskErr, TaskOk } from '../../../src/ai/runner.js'
import type { ChatMsg } from '../../../src/ai/provider/types.js'

/** 写风险工具名（从契约表取，防手抄漂移）。 */
const WRITE_TOOL = Object.entries(TOOL_RISK).find(([, risk]) => risk === 'write')?.[0] ?? ''
/** 未注册工具名（保证不在 TOOL_RISK 里）。 */
const UNKNOWN_TOOL = '不存在的工具_r0916_7'

function okOut(data: Partial<ChatGeneration> = {}): TaskOk<ChatGeneration> {
  return {
    ok: true,
    data: { text: '', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, reasoning: '', ...data },
    ctrl: new AbortController(),
    usage: { inputTokens: 1, outputTokens: 1 },
    runId: 'run-1',
    model: null,
  }
}

function errOut(code: TaskCode, error = 'e'): TaskErr {
  return { ok: false, code, error }
}

interface Harness {
  deps: TurnDeps
  emitted: Record<string, unknown>[]
  added: NewEvent[]
  masks: string[]
  history: ChatMsg[]
  state: ChatRunState
  completedCount: () => number
}

function mkHarness(over: Partial<TurnDeps> = {}): Harness {
  const emitted: Record<string, unknown>[] = []
  const opts = {
    driver: {
      emit: (_session: unknown, ev: Record<string, unknown>) => {
        emitted.push(ev)
      },
    },
    mainSession: 'sess',
    bookName: 'b',
    bookRoot: 'R',
    message: undefined,
    regenerate: undefined,
    userDataPath: null,
    deadlineMs: undefined,
    chapter: undefined,
  } as unknown as ChatOpts
  const state: ChatRunState = { ctrl: new AbortController(), deadline: Date.now() + 60_000, pending: new Map() }
  const history: ChatMsg[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '旧回复' },
    { role: 'user', content: '再说' },
  ]
  const added: NewEvent[] = []
  const masks: string[] = []
  const recorder = {
    add: (ev: NewEvent): number => {
      added.push(ev)
      return added.length
    },
    closeMaskingAll: (mask: string): void => {
      masks.push(mask)
    },
  } as unknown as SessionRecorder
  const seqs: ChatSeqLedger = { msgSeqs: [], pendingMsgSeqs: [], commitPendingMsgSeqs: () => {} }
  let completed = 0
  const deps: TurnDeps = {
    opts,
    state,
    confirmTimeout: 30,
    history,
    baseLen: 1,
    recorder,
    sys: 'sys',
    turnBranch: undefined,
    digests: { settings: 'dg' },
    promptFiles: [],
    revisionPath: undefined,
    seqs,
    markCompleted: () => {
      completed++
    },
    ...over,
  }
  return { deps, emitted, added, masks, history, state, completedCount: () => completed }
}

/** 事件类型序（emit 侧）。 */
const emitTypes = (h: Harness): unknown[] => h.emitted.map((e) => e['type'])
/** 事件类型序（落库侧）。 */
const addedTypes = (h: Harness): string[] => h.added.map((e) => e.type)

describe('R0916-7-P3-2 turns-phases：单轮终态分流（纯判定）', () => {
  const toolCall = { id: 'c1', name: 't', input: {} }
  const cases: [string, ChatSendOut, boolean, string][] = [
    ['ABORTED（用户中断）', errOut('ABORTED'), false, 'interrupted'],
    ['TIMEOUT_TOTAL（档位超时）', errOut('TIMEOUT_TOTAL'), false, 'timeout'],
    ['deadline 触发的 abort（timedOut 置位）优先归超时', errOut('ABORTED'), true, 'timeout'],
    ['GEN_FAIL 等其余失败透传文案', errOut('GEN_FAIL'), false, 'error'],
    ['max_tokens 截断出口', okOut({ stopReason: 'max_tokens' }), false, 'max-tokens'],
    ['max_tokens 且带工具（半截入参绝不执行）', okOut({ stopReason: 'max_tokens', toolCalls: [toolCall] }), false, 'max-tokens'],
    ['无工具调用 → 完成面', okOut(), false, 'no-tools'],
    ['有工具调用 → 交工具段', okOut({ toolCalls: [toolCall] }), false, 'tools'],
  ]
  it.each(cases)('%s', (_name, out, timedOut, expected) => {
    expect(judgeTurnTermination(out, timedOut)).toBe(expected)
  })
})

describe('R0916-7-P3-2 turns-phases：轮首常量与末条指纹', () => {
  it('MAX_AGENT_TURNS 与触顶收尾同源（0917清库修复批：5 → 20）', () => {
    expect(MAX_AGENT_TURNS).toBe(20)
  })

  it('CHAT_TOOL_NAMES = chatTools 名清单（铁律②工具面登记单源）', () => {
    expect(CHAT_TOOL_NAMES).toEqual(chatTools.map((t) => t.name))
  })

  it('lastMessageFingerprint：空历史 / 纯文本 / blocks 序列化', () => {
    expect(lastMessageFingerprint([])).toBe('')
    expect(lastMessageFingerprint([{ role: 'user', content: '甲' }])).toBe('甲')
    const blocks: ChatMsg = { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'r', isError: false }] }
    expect(lastMessageFingerprint([blocks])).toBe(JSON.stringify(blocks.content))
  })
})

describe('R0916-7-P3-2 turns-phases：阶段二工具派发与回填（顺序不变量）', () => {
  it('未知工具：直接 isError 回填，不弹确认卡；history 顺序 assistant → user(tool_result)', async () => {
    const h = mkHarness()
    const out = okOut({ text: '正文', reasoning: '理由', toolCalls: [{ id: 'c1', name: UNKNOWN_TOOL, input: { a: 1 } }] })
    const completedOk = await runToolTurn({ deps: h.deps, turn: 1, out, lineageIdx: [9], flushTurnEvents: () => true })

    expect(completedOk).toBe(true)
    // history：assistant（text→reasoning→tool_use 序）→ user(tool_result)
    const asst = h.history[3]
    expect(asst?.role).toBe('assistant')
    expect(asst?.content).toEqual([
      { type: 'text', text: '正文' },
      { type: 'reasoning', text: '理由' },
      { type: 'tool_use', id: 'c1', name: UNKNOWN_TOOL, input: { a: 1 } },
    ])
    const toolMsg = h.history[4]
    expect(toolMsg?.role).toBe('user')
    expect(toolMsg?.content).toEqual([
      { type: 'tool_result', toolUseId: 'c1', content: `未知工具：${UNKNOWN_TOOL}（未注册，无法执行）`, isError: true },
    ])
    // 未注册工具不弹确认卡（R76-13/R33D-13）；事件序 assistant/message → tool/call → tool/result → turn/end
    expect(emitTypes(h)).toEqual(['chat_tool_result'])
    expect(addedTypes(h)).toEqual(['assistant/message', 'tool/call', 'tool/result', 'turn/end'])
    expect(h.added[3]?.type === 'turn/end' && h.added[3].turn).toBe(1)
    // seqs：assistant 条（单序号）+ 本轮 tool_result 条（合成一条 user 消息的多序号）
    expect(h.deps.seqs.pendingMsgSeqs.length).toBe(2)
    expect(typeof h.deps.seqs.pendingMsgSeqs[0]).toBe('number')
    expect(Array.isArray(h.deps.seqs.pendingMsgSeqs[1])).toBe(true)
  })

  it('轮首级 abort 短路：剩余工具逐个按取消口径回填（不执行、不弹确认）', async () => {
    const h = mkHarness()
    h.state.ctrl.abort()
    const out = okOut({ toolCalls: [{ id: 'c1', name: UNKNOWN_TOOL, input: {} }] })
    await runToolTurn({ deps: h.deps, turn: 1, out, lineageIdx: [], flushTurnEvents: () => true })
    expect(h.history[4]?.content).toEqual([
      { type: 'tool_result', toolUseId: 'c1', content: '作者取消了该操作。', isError: true },
    ])
    expect(emitTypes(h)).toEqual(['chat_tool_result'])
  })

  it('写风险确认闸：作者取消与确认超时文案分开归因（P5-AI）', async () => {
    expect(WRITE_TOOL).not.toBe('')
    // 人工取消：待确认挂起后从外部按取消收口
    const cancel = mkHarness()
    const out1 = okOut({ toolCalls: [{ id: 'c1', name: WRITE_TOOL, input: { chapter: 1 } }] })
    const p1 = runToolTurn({ deps: cancel.deps, turn: 1, out: out1, lineageIdx: [], flushTurnEvents: () => true })
    expect(cancel.state.pending.has('c1'), '写风险工具须先挂起确认').toBe(true)
    cancel.state.pending.get('c1')?.(false)
    await p1
    expect(cancel.history[4]?.content).toEqual([
      { type: 'tool_result', toolUseId: 'c1', content: '作者取消了该操作。', isError: true },
    ])
    expect(emitTypes(cancel)).toEqual(['chat_tool_pending', 'chat_tool_result'])

    // 确认超时（confirmTimeout=30ms）：文案区分 + confirmTimedOut 留痕
    const timeout = mkHarness()
    const out2 = okOut({ toolCalls: [{ id: 'c2', name: WRITE_TOOL, input: { chapter: 1 } }] })
    await runToolTurn({ deps: timeout.deps, turn: 1, out: out2, lineageIdx: [], flushTurnEvents: () => true })
    expect(timeout.history[4]?.content).toEqual([
      { type: 'tool_result', toolUseId: 'c2', content: '确认超时，本次操作未执行（可重发指令）。', isError: true },
    ])
    expect(timeout.state.confirmTimedOut?.has('c2')).toBe(true)
  })

  it('落库失败（flushTurnEvents=false）→ false：轮循环据此终止', async () => {
    const h = mkHarness()
    const out = okOut({ toolCalls: [{ id: 'c1', name: UNKNOWN_TOOL, input: {} }] })
    const completedOk = await runToolTurn({ deps: h.deps, turn: 2, out, lineageIdx: [], flushTurnEvents: () => false })
    expect(completedOk).toBe(false)
  })
})

describe('R0916-7-P3-2 turns-phases：阶段三收尾与失败面 mask 分流', () => {
  const failCases: [string, ChatSendOut, string, RegExp][] = [
    ['ABORTED → interrupted', errOut('ABORTED'), 'interrupted', /^已中断$/],
    ['TIMEOUT_TOTAL → aborted + 超时文案', errOut('TIMEOUT_TOTAL'), 'aborted', /^对话超时（超过 \d+ 分钟），已停止$/],
    ['其余失败 → error 透传文案', errOut('GEN_FAIL', 'boom'), 'error', /^boom$/],
  ]
  it.each(failCases)('%s：回滚 history + 遮蔽 mask + chat_error', async (_name, out, mask, message) => {
    const h = mkHarness()
    const closure = await closeAgentTurn({ deps: h.deps, turn: 3, out, lineageIdx: [], flushTurnEvents: () => true })
    expect(closure).toEqual({ ended: true, completedOk: false })
    expect(h.masks).toEqual([mask])
    expect(h.history.length).toBe(1) // 回滚到 baseLen（防末尾 user → 下次连续 user 400）
    expect(emitTypes(h)).toEqual(['chat_error'])
    const errMsg = h.emitted[0]?.['error']
    expect(typeof errMsg === 'string' && message.test(errMsg)).toBe(true)
  })

  it('deadline 触发的 abort（timedOut 置位）按超时收口（与轮首分支同文案）', async () => {
    const h = mkHarness()
    h.state.timedOut = true
    const closure = await closeAgentTurn({ deps: h.deps, turn: 3, out: errOut('ABORTED'), lineageIdx: [], flushTurnEvents: () => true })
    expect(closure).toEqual({ ended: true, completedOk: false })
    expect(h.masks).toEqual(['aborted'])
    expect(String(h.emitted[0]?.['error'])).toMatch(/^对话超时（超过 \d+ 分钟），已停止$/)
  })

  it('max_tokens 截断面：回滚 + mask max-tokens（半截文本不入 history，K12）', async () => {
    const h = mkHarness()
    const closure = await closeAgentTurn({ deps: h.deps, turn: 3, out: okOut({ stopReason: 'max_tokens' }), lineageIdx: [], flushTurnEvents: () => true })
    expect(closure).toEqual({ ended: true, completedOk: false })
    expect(h.masks).toEqual(['max-tokens'])
    expect(h.history.length).toBe(1)
  })

  it('工具轮不终结：成功封套原样交阶段二，无遮蔽无收尾', async () => {
    const h = mkHarness()
    const out = okOut({ toolCalls: [{ id: 'c1', name: 't', input: {} }] })
    const closure = await closeAgentTurn({ deps: h.deps, turn: 3, out, lineageIdx: [], flushTurnEvents: () => true })
    expect(closure.ended).toBe(false)
    expect(closure.ended === false && closure.out).toBe(out)
    expect(h.masks).toEqual([])
    expect(emitTypes(h)).toEqual([])
  })

  it('无工具完成面：reasoning 非空入历史（blocks 序 text→reasoning），先广播后压缩', async () => {
    const h = mkHarness()
    const closure = await closeAgentTurn({
      deps: h.deps,
      turn: 3,
      out: okOut({ text: '甲', reasoning: '乙', stopReason: 'stop' }),
      lineageIdx: [4],
      // finalizeHistory（压缩/摘要 IO）不在本用例面：落库闸返回 false 即止步于 chat_done 之前
      flushTurnEvents: () => false,
    })
    expect(closure).toEqual({ ended: true, completedOk: false })
    expect(h.history[3]?.content).toEqual([
      { type: 'text', text: '甲' },
      { type: 'reasoning', text: '乙' },
    ])
    expect(addedTypes(h)).toEqual(['assistant/message', 'turn/end'])
    expect(emitTypes(h)).toEqual([]) // chat_done 在落库成功之后才发
    expect(h.completedCount()).toBe(0)
  })

  it('无工具完成面：reasoning 为空 → 纯文本入历史', async () => {
    const h = mkHarness()
    await closeAgentTurn({ deps: h.deps, turn: 3, out: okOut({ text: '甲' }), lineageIdx: [], flushTurnEvents: () => false })
    expect(h.history[3]?.content).toBe('甲')
  })
})

describe('R0916-7-P3-2 turns-phases：轮数触顶收尾', () => {
  it('触顶：收尾文案入历史 + turn/start(MAX) 与 turn/end(max-turns) 同章号 + 落库闸前止步', async () => {
    const h = mkHarness()
    const completedOk = await closeByTurnLimit({ deps: h.deps, lastTurnUsage: undefined, flushTurnEvents: () => false })
    expect(completedOk).toBe(false)
    const last = h.history[h.history.length - 1]
    expect(last?.role).toBe('assistant')
    expect(String(last?.content)).toContain('已达到单次对话的工具调用上限')
    expect(emitTypes(h)).toEqual(['chat_turn', 'chat_text'])
    expect(h.emitted[0]?.['turn']).toBe(MAX_AGENT_TURNS)
    const turnEnd = h.added.find((e) => e.type === 'turn/end')
    // CC-P2-1：终态章号与 chat_turn 的 turn=MAX_AGENT_TURNS 同口径（不再同轮双终态）
    expect(turnEnd && turnEnd.type === 'turn/end' && turnEnd.turn).toBe(MAX_AGENT_TURNS)
    expect(turnEnd && turnEnd.type === 'turn/end' && turnEnd.data.reason).toBe('max-turns')
    expect(h.completedCount()).toBe(0)
  })
})
