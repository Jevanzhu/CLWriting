/**
 * R0916-7-P3-2（全项目源码质量与优雅度评审 P3-2）直测：responses-stream 单元。
 *
 * responses-adapter.stream 原为 232 行 / 圈复杂度 83 / 嵌套 9 的单函数，本批按
 * 「流事件解析 / 增量产出 / 工具调用累积 / 收尾与降级判决」四段切出：本用例逐段表驱动
 * 覆盖关键分支，并锁四条不变量（语义锚 = 既有集成用例 adapter-responses.test.ts）：
 * ① 产出顺序 = 线上事件序；② done/error 壳只经 fin 取；③ usage 估计基准恒首发请求；
 * ④ stop=true 表示该 arm 已产出终态（调用方先 yield 完再 return）。
 * 副作用面（fin / 请求）全经参数注入，本用例用记录式假 finalizer 观察调用实参。
 */
import { describe, expect, it } from 'vitest'
import type OpenAI from 'openai'
import {
  applyCompleted,
  applyFailed,
  applyFunctionCallArgsDelta,
  applyIncomplete,
  applyReasoningDelta,
  applyResponsesStreamEvent,
  applyStreamError,
  applyTextDelta,
  claimOutputItemFunctionCall,
  claimOutputItemReasoning,
  closeStreamAttempt,
  createResponsesStreamAccum,
  estimateAttemptUsage,
  isRealUsage,
  parseToolArgs,
  resolveUsage,
  toUsage,
  type ResponsesStreamAccum,
  type StreamEventCtx,
} from '../../../src/ai/provider/responses-stream.js'
import type { EstimateUsageSources, StreamFinalizer } from '../../../src/ai/provider/stream-finalize.js'
import type { GenErrorCode, GenEvent, GenRequest, StopReason, TokenUsage } from '../../../src/ai/provider/types.js'

const REQ: GenRequest = { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] }
/** 假 finalizer 的估计哨兵值——出现即证「走了估计分支」。 */
const ESTIMATED: TokenUsage = { inputTokens: 11, outputTokens: 22, estimated: true }

interface FinRec {
  doneRaw: (string | null | undefined)[]
  doneUsage: TokenUsage[]
  terminal: { message: string; usage: TokenUsage; code?: GenErrorCode }[]
  truncated: TokenUsage[]
  estimates: EstimateUsageSources[]
}

/** 记录式假收口件：壳形状由本用例自定，观察点是「何时向 fin 要哪个壳 + 实参」。 */
function recordingFin(): { fin: StreamFinalizer; rec: FinRec } {
  const rec: FinRec = { doneRaw: [], doneUsage: [], terminal: [], truncated: [], estimates: [] }
  const fin: StreamFinalizer = {
    doneEmitted: () => rec.doneRaw.length > 0,
    done: (usage, rawStopReason) => {
      rec.doneUsage.push(usage)
      rec.doneRaw.push(rawStopReason)
      return { type: 'done', usage, stopReason: (rawStopReason ?? 'unknown') as StopReason }
    },
    filterError: () => null,
    terminalError: (message, usage, code) => {
      rec.terminal.push({ message, usage, ...(code !== undefined ? { code } : {}) })
      return { type: 'error', message, retryable: false, ...(code !== undefined ? { code } : {}), usage }
    },
    truncatedError: (usage) => {
      rec.truncated.push(usage)
      return { type: 'error', message: '传输截断：流结束无终止事件', retryable: true, code: 'NETWORK', usage }
    },
    estimateUsage: (src) => {
      rec.estimates.push(src)
      return ESTIMATED
    },
  }
  return { fin, rec }
}

function mkCtx(model = 'm1'): { ctx: StreamEventCtx; rec: FinRec } {
  const { fin, rec } = recordingFin()
  return { ctx: { fin, req: REQ, model }, rec }
}

// ── SDK 形状构造（只填被测字段，余者由 cast 补齐）─────────────────────────────
const usageOf = (u: Record<string, unknown>): OpenAI.Responses.ResponseUsage =>
  u as unknown as OpenAI.Responses.ResponseUsage
const respOf = (r: Record<string, unknown>): OpenAI.Responses.Response => r as unknown as OpenAI.Responses.Response
const deltaEv = (itemId: string | undefined, delta: string): OpenAI.Responses.ResponseFunctionCallArgumentsDeltaEvent =>
  ({ type: 'response.function_call_arguments.delta', item_id: itemId, delta, output_index: 0 }) as unknown as OpenAI.Responses.ResponseFunctionCallArgumentsDeltaEvent
const fnCallItem = (o: { id?: string; call_id?: string; name: string; arguments: string }): OpenAI.Responses.ResponseFunctionToolCall =>
  ({ type: 'function_call', ...o }) as unknown as OpenAI.Responses.ResponseFunctionToolCall
const msgItem = (text: string): OpenAI.Responses.ResponseOutputItem =>
  ({ type: 'message', content: [{ type: 'output_text', text }] }) as unknown as OpenAI.Responses.ResponseOutputItem
const streamEv = (o: Record<string, unknown>): OpenAI.Responses.ResponseStreamEvent =>
  o as unknown as OpenAI.Responses.ResponseStreamEvent

/** 取事件序列的 type 名（断言顺序用）。 */
const typesOf = (evs: GenEvent[]): string[] => evs.map((e) => e.type)

describe('R0916-7-P3-2 responses-stream：usage 归一与采信', () => {
  it('toUsage：input 扣 cached（R3 缺口 12 归一）、cached/reasoning 为 0 不出键', () => {
    expect(toUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(toUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(
      toUsage(usageOf({ input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 3 } })),
    ).toEqual({ inputTokens: 60, outputTokens: 7, cacheReadTokens: 40, reasoningTokens: 3 })
    // 扣减不为负（异常网关 cached > input）
    expect(toUsage(usageOf({ input_tokens: 3, output_tokens: 1, input_tokens_details: { cached_tokens: 5 } }))).toEqual({
      inputTokens: 0,
      outputTokens: 1,
      cacheReadTokens: 5,
    })
  })

  const realCases: [string, OpenAI.Responses.ResponseUsage | null | undefined, boolean][] = [
    ['null', null, false],
    ['undefined', undefined, false],
    ['空对象 {}（R38-8：假计量，等价无 usage）', usageOf({}), false],
    ['仅 total_tokens（无计量字段）', usageOf({ total_tokens: 5 }), false],
    ['input_tokens=0（字段在位即采信）', usageOf({ input_tokens: 0 }), true],
    ['output_tokens=0（同上）', usageOf({ output_tokens: 0 }), true],
    ['双字段齐（真 usage）', usageOf({ input_tokens: 12, output_tokens: 3 }), true],
  ]
  it.each(realCases)('isRealUsage：%s → %s', (_name, u, expected) => {
    expect(isRealUsage(u)).toBe(expected)
  })
})

describe('R0916-7-P3-2 responses-stream：工具入参归一', () => {
  const cases: [string, string, unknown][] = [
    ['空串 → {}', '', {}],
    ['合法对象', '{"q":1,"n":null}', { q: 1, n: null }],
    ['数组（非对象）落 _raw', '[1,2]', { _raw: '[1,2]' }],
    ['裸数字落 _raw（跨协议换供方防 400）', '5', { _raw: '5' }],
    ['裸字符串落 _raw', '"s"', { _raw: '"s"' }],
    ['裸布尔落 _raw', 'true', { _raw: 'true' }],
    ['null 落 _raw（typeof null 陷阱）', 'null', { _raw: 'null' }],
    ['畸形 JSON 落 _raw', 'not-json', { _raw: 'not-json' }],
  ]
  it.each(cases)('parseToolArgs：%s', (_name, raw, expected) => {
    expect(parseToolArgs(raw)).toEqual(expected)
  })
})

describe('R0916-7-P3-2 responses-stream：增量产出', () => {
  it('正文 delta：产出累计 + textYielded 置位 + 透出', () => {
    const st = createResponsesStreamAccum()
    expect(applyTextDelta(st, '')).toEqual([])
    expect(applyTextDelta(st, undefined)).toEqual([])
    expect(st.outText).toEqual([])
    expect(st.textYielded).toBe(false)
    expect(applyTextDelta(st, '甲')).toEqual([{ type: 'text', delta: '甲' }])
    expect(st.outText).toEqual(['甲'])
    expect(st.textYielded).toBe(true)
  })

  it('推理 delta：计费累计入 outText 但**不置** textYielded（正文面判据分家）', () => {
    const st = createResponsesStreamAccum()
    expect(applyReasoningDelta(st, undefined)).toEqual([])
    expect(applyReasoningDelta(st, '想')).toEqual([{ type: 'reasoning', delta: '想' }])
    expect(st.outText).toEqual(['想'])
    expect(st.textYielded).toBe(false)
    expect(st.toolYielded).toBe(false)
  })
})

describe('R0916-7-P3-2 responses-stream：工具调用累积', () => {
  it('有 item_id：分片归并同一键', () => {
    const st = createResponsesStreamAccum()
    applyFunctionCallArgsDelta(st, deltaEv('fc_1', '{"q"'))
    applyFunctionCallArgsDelta(st, deltaEv('fc_1', ':1}'))
    expect(st.toolAccum.get('fc_1')?.args).toBe('{"q":1}')
  })

  it('缺 item_id：续片归并最近兜底键，不新建', () => {
    const st = createResponsesStreamAccum()
    applyFunctionCallArgsDelta(st, deltaEv(undefined, '{"q"'))
    applyFunctionCallArgsDelta(st, deltaEv(undefined, ':1}'))
    expect(st.idxlessQueue).toEqual(['no-item-id-1'])
    expect(st.toolAccum.get('no-item-id-1')?.args).toBe('{"q":1}')
  })

  it('缺 item_id 的两个调用不串参数（R65-10：done 按流式序 FIFO 认领队头）', () => {
    const st = createResponsesStreamAccum()
    applyFunctionCallArgsDelta(st, deltaEv(undefined, 'A'))
    applyFunctionCallArgsDelta(st, deltaEv(undefined, 'B'))
    const first = claimOutputItemFunctionCall(st, fnCallItem({ id: 'call_1', name: 't1', arguments: '' }))
    expect(first).toEqual({ type: 'tool', id: 'call_1', name: 't1', input: { _raw: 'AB' } })
    // 第一个键已随认领删除 → 后续无 item_id 的片开新兜底键
    applyFunctionCallArgsDelta(st, deltaEv(undefined, 'C'))
    expect(st.idxlessQueue).toEqual(['no-item-id-2'])
    const second = claimOutputItemFunctionCall(st, fnCallItem({ id: 'call_2', name: 't2', arguments: '' }))
    expect(second).toEqual({ type: 'tool', id: 'call_2', name: 't2', input: { _raw: 'C' } })
  })

  it('done 直接键命中：权威 arguments 覆盖 delta 累计（R38-7），call_id 优先 id', () => {
    const st = createResponsesStreamAccum()
    applyFunctionCallArgsDelta(st, deltaEv('fc_1', '{"q":1}'))
    const ev = claimOutputItemFunctionCall(st, fnCallItem({ id: 'fc_1', call_id: 'call_a', name: 'add', arguments: '{"q":2}' }))
    expect(ev).toEqual({ type: 'tool', id: 'call_a', name: 'add', input: { q: 2 } })
    expect(st.outToolText).toEqual(['add{"q":2}'])
    expect(st.toolYielded).toBe(true)
    expect(st.toolAccum.size).toBe(0)
  })

  it('done 权威串缺失：回落 delta 累计；call_id/id 双缺 → 流级单调兜底 id', () => {
    const st = createResponsesStreamAccum()
    applyFunctionCallArgsDelta(st, deltaEv('fc_1', '{"q":1}'))
    expect(claimOutputItemFunctionCall(st, fnCallItem({ id: 'fc_1', name: 'add', arguments: '' }))).toEqual({
      type: 'tool',
      id: 'fc_1',
      name: 'add',
      input: { q: 1 },
    })
    const a = claimOutputItemFunctionCall(st, fnCallItem({ id: '', name: 'x', arguments: '' }))
    const b = claimOutputItemFunctionCall(st, fnCallItem({ id: '', name: 'y', arguments: '' }))
    expect([a.type === 'tool' ? a.id : '', b.type === 'tool' ? b.id : '']).toEqual(['call_0', 'call_1'])
  })

  it('reasoning 项：无 encrypted 不产出不计；有则计数 + 透出 itemId', () => {
    const st = createResponsesStreamAccum()
    expect(claimOutputItemReasoning(st, { type: 'reasoning' } as OpenAI.Responses.ResponseReasoningItem)).toEqual([])
    expect(st.reasoningItemCount).toBe(0)
    expect(
      claimOutputItemReasoning(st, { type: 'reasoning', id: 'r1', encrypted_content: 'enc' } as OpenAI.Responses.ResponseReasoningItem),
    ).toEqual([{ type: 'reasoning_item', encrypted: 'enc', itemId: 'r1' }])
    expect(st.reasoningItemCount).toBe(1)
  })
})

describe('R0916-7-P3-2 responses-stream：usage 采信 / 估计（基准恒首发请求）', () => {
  it('真 usage 在位 → toUsage 直取，不问估计', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    const u = usageOf({ input_tokens: 100, output_tokens: 7 })
    expect(resolveUsage(st, u, ctx)).toEqual({ inputTokens: 100, outputTokens: 7 })
    expect(rec.estimates).toEqual([])
  })

  it('usage 缺席 / {} → 走 fin.estimateUsage，req 恒首发请求（降级 attempt 不参与折算）', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    expect(resolveUsage(st, undefined, ctx)).toEqual(ESTIMATED)
    expect(resolveUsage(st, usageOf({}), ctx)).toEqual(ESTIMATED)
    expect(rec.estimates.length).toBe(2)
    for (const src of rec.estimates) expect(src.req).toBe(REQ)
  })

  it('estimateAttemptUsage：正文/工具产出/在途未认领分片一并折算', () => {
    const { ctx, rec } = mkCtx('mm')
    const st = createResponsesStreamAccum()
    applyTextDelta(st, '甲')
    applyFunctionCallArgsDelta(st, deltaEv('fc_1', '{"q":1}'))
    claimOutputItemFunctionCall(st, fnCallItem({ id: 'fc_1', name: 'add', arguments: '{"q":1}' }))
    applyFunctionCallArgsDelta(st, deltaEv('fc_2', '{"r"')) // 在途未认领
    estimateAttemptUsage(st, ctx)
    expect(rec.estimates[0]).toEqual({
      req: REQ,
      model: 'mm',
      outText: ['甲'],
      outToolText: ['add{"q":1}'],
      pendingToolText: ['{"r"'],
    })
  })
})

describe('R0916-7-P3-2 responses-stream：completed 终态判决', () => {
  it('正常完成（有正文产出）：done，末态非终止（stop=false，续收线上余量）', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    applyTextDelta(st, '甲')
    const step = applyCompleted(st, respOf({ output: [], usage: usageOf({ input_tokens: 5, output_tokens: 2 }) }), ctx)
    expect(typesOf(step.events)).toEqual(['done'])
    expect(step.stop).toBe(false)
    expect(st.terminal).toBe('completed')
    expect(rec.doneRaw).toEqual(['stop'])
    expect(rec.doneUsage[0]).toEqual({ inputTokens: 5, outputTokens: 2 })
  })

  it('工具已产出 → done 的 stopReason 走 tool_use', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    claimOutputItemFunctionCall(st, fnCallItem({ id: 'c1', name: 'add', arguments: '{}' }))
    const step = applyCompleted(st, respOf({ output: [], usage: usageOf({ input_tokens: 1, output_tokens: 1 }) }), ctx)
    expect(typesOf(step.events)).toEqual(['done'])
    expect(rec.doneRaw).toEqual(['tool_use'])
  })

  it('伪流回填 text（R35-18）：无 delta 流出时 completed 的 message 项是唯一产出', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    const step = applyCompleted(st, respOf({ output: [msgItem('全文')], usage: usageOf({ input_tokens: 1, output_tokens: 1 }) }), ctx)
    expect(step.events[0]).toEqual({ type: 'text', delta: '全文' })
    expect(typesOf(step.events)).toEqual(['text', 'done'])
    expect(st.outText).toEqual(['全文'])
    expect(st.textYielded).toBe(true)
    expect(rec.doneRaw).toEqual(['stop'])
  })

  it('伪流回填 tool（C103）：completed 只含 function_call 项时补发 tool 事件', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    const step = applyCompleted(
      st,
      respOf({ output: [fnCallItem({ call_id: 'c9', name: 'add', arguments: '{"a":1}' })], usage: usageOf({ input_tokens: 1, output_tokens: 1 }) }),
      ctx,
    )
    expect(step.events[0]).toEqual({ type: 'tool', id: 'c9', name: 'add', input: { a: 1 } })
    expect(typesOf(step.events)).toEqual(['tool', 'done'])
    expect(st.outToolText).toEqual(['add{"a":1}'])
    expect(rec.doneRaw).toEqual(['tool_use'])
  })

  it('已有产出不回填（防双份）：delta 流出后 completed 带 message 项不再回填', () => {
    const { ctx } = mkCtx()
    const st = createResponsesStreamAccum()
    applyTextDelta(st, '甲')
    const step = applyCompleted(st, respOf({ output: [msgItem('甲')], usage: usageOf({ input_tokens: 1, output_tokens: 1 }) }), ctx)
    expect(typesOf(step.events)).toEqual(['done'])
    expect(st.outText).toEqual(['甲'])
  })

  it('空产出判错（R1/R26-4）：无产出项且未流出内容 → 终态 error 不发 done，usage 走估计', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    const step = applyCompleted(st, respOf({ output: [] }), ctx)
    expect(typesOf(step.events)).toEqual(['error'])
    expect(step.stop).toBe(true)
    expect(rec.terminal[0]?.message).toBe('模型返回空产出（Responses completed 无内容项）')
    expect(rec.terminal[0]?.usage).toEqual(ESTIMATED)
    expect(rec.doneRaw).toEqual([])
  })

  it('reasoning-only 不静默判成功（重评-0912-2 P2-2）：判断据只认正文实际 yield，outText 不作产出判据', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    applyReasoningDelta(st, '想了半天')
    const step = applyCompleted(st, respOf({ output: [] }), ctx)
    expect(step.stop).toBe(true)
    expect(rec.terminal[0]?.message).toBe('模型返回空产出（Responses completed 无内容项）')
    expect(rec.doneRaw).toEqual([])
  })

  it('message 项在位（无文本部件）即算有产出 → done（不判空产出）', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    const empty = { type: 'message', content: [] } as unknown as OpenAI.Responses.ResponseOutputItem
    const step = applyCompleted(st, respOf({ output: [empty], usage: usageOf({ input_tokens: 1, output_tokens: 1 }) }), ctx)
    expect(typesOf(step.events)).toEqual(['done'])
    expect(rec.doneRaw).toEqual(['stop'])
  })
})

describe('R0916-7-P3-2 responses-stream：incomplete / failed / error 终态判决', () => {
  it('incomplete(max_output_tokens) → done(max_tokens)，非终止', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    const step = applyIncomplete(
      st,
      respOf({ incomplete_details: { reason: 'max_output_tokens' }, usage: usageOf({ input_tokens: 9, output_tokens: 3 }) }),
      ctx,
    )
    expect(typesOf(step.events)).toEqual(['done'])
    expect(step.stop).toBe(false)
    expect(st.terminal).toBe('incomplete')
    expect(rec.doneRaw).toEqual(['max_tokens'])
  })

  it.each([
    ['content_filter', '响应不完整：content_filter'],
    [undefined, '响应不完整：unknown'],
  ])('incomplete(%s) 不得伪装成正常 stop → 终态 error', (reason, message) => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    const step = applyIncomplete(st, respOf({ incomplete_details: { reason }, usage: usageOf({ input_tokens: 9, output_tokens: 3 }) }), ctx)
    expect(typesOf(step.events)).toEqual(['error'])
    expect(step.stop).toBe(true)
    expect(rec.terminal[0]?.message).toBe(message)
    // 已发生消耗随错上抛（R32-2）
    expect(rec.terminal[0]?.usage).toEqual({ inputTokens: 9, outputTokens: 3 })
  })

  it('failed → 终态 error（码 PROTOCOL，脱敏，不发 done）', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    const step = applyFailed(st, respOf({ error: { message: 'bad key sk-abcdefghijklmnopqrstuvwxyz' } }), ctx)
    expect(typesOf(step.events)).toEqual(['error'])
    expect(step.stop).toBe(true)
    expect(st.terminal).toBe('failed')
    expect(rec.terminal[0]?.code).toBe('PROTOCOL')
    expect(rec.terminal[0]?.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(rec.terminal[0]?.usage).toEqual(ESTIMATED)
    expect(rec.doneRaw).toEqual([])
  })

  it('failed 无 message → 回落 status 文案', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    applyFailed(st, respOf({ status: 500 }), ctx)
    expect(rec.terminal[0]?.message).toBe('response.failed (status=500)')
  })

  it.each(['completed', 'incomplete', 'failed'] as const)('终态已置（%s）后 failed/error 抖动被忽略——done 不被翻转', (terminal) => {
    const { ctx, rec } = mkCtx()
    for (const fire of [
      (st: ResponsesStreamAccum) => applyFailed(st, respOf({ error: { message: 'x' } }), ctx),
      (st: ResponsesStreamAccum) => applyStreamError(st, streamEv({ type: 'error', message: 'y' }) as OpenAI.Responses.ResponseErrorEvent, ctx),
    ]) {
      const st = createResponsesStreamAccum()
      st.terminal = terminal
      const step = fire(st)
      expect(step).toEqual({ events: [], stop: false })
    }
    expect(rec.terminal).toEqual([])
  })

  it('流中 error 事件：终态 error（PROTOCOL）+ 估计 usage；无 message 落默认文案', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    const step = applyStreamError(st, streamEv({ type: 'error' }) as OpenAI.Responses.ResponseErrorEvent, ctx)
    expect(step.stop).toBe(true)
    expect(rec.terminal[0]?.message).toBe('流中错误事件')
    expect(rec.terminal[0]?.code).toBe('PROTOCOL')
    expect(rec.terminal[0]?.usage).toEqual(ESTIMATED)
  })
})

describe('R0916-7-P3-2 responses-stream：流尾收尾', () => {
  it('无终止事件 = 传输截断 → truncatedError，截断折算先于 toolAccum 清空（在途参数计入）', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    applyFunctionCallArgsDelta(st, deltaEv('fc_1', '{"a"'))
    const tail = closeStreamAttempt(st, ctx)
    expect(tail.events[0]).toEqual({
      type: 'error',
      message: '传输截断：流结束无终止事件',
      retryable: true,
      code: 'NETWORK',
      usage: ESTIMATED,
    })
    expect(rec.estimates[0]?.pendingToolText).toEqual(['{"a"'])
    expect(st.toolAccum.size).toBe(0)
  })

  it('终止事件在位 → 不发截断壳，也不问估计', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    st.terminal = 'completed'
    expect(closeStreamAttempt(st, ctx)).toEqual({ events: [], discardedReasoningItems: 0 })
    expect(rec.truncated).toEqual([])
    expect(rec.estimates).toEqual([])
  })

  it.each([
    [0, 0],
    [1, 0],
    [3, 2],
  ])('加密推理项计数 %s → 留存 %s 条、其余按覆盖丢弃留痕', (count, discarded) => {
    const { ctx } = mkCtx()
    const st = createResponsesStreamAccum()
    st.reasoningItemCount = count
    expect(closeStreamAttempt(st, ctx).discardedReasoningItems).toBe(discarded)
  })
})

describe('R0916-7-P3-2 responses-stream：单入口分发（产出顺序 = 线上事件序）', () => {
  const cases: [string, Record<string, unknown>, string[], boolean][] = [
    ['正文 delta', { type: 'response.output_text.delta', delta: '甲' }, ['text'], false],
    ['推理文本 delta', { type: 'response.reasoning_text.delta', delta: '乙' }, ['reasoning'], false],
    ['推理摘要 delta', { type: 'response.reasoning_summary_text.delta', delta: '丙' }, ['reasoning'], false],
    ['工具参数 delta（只累积不产出）', { type: 'response.function_call_arguments.delta', item_id: 'fc', delta: '{}' }, [], false],
    ['未知事件类型静默跳过', { type: 'response.created' }, [], false],
  ]
  it.each(cases)('%s', (_name, event, expectedTypes, expectedStop) => {
    const { ctx } = mkCtx()
    const st = createResponsesStreamAccum()
    const step = applyResponsesStreamEvent(st, streamEv(event), ctx)
    expect(typesOf(step.events)).toEqual(expectedTypes)
    expect(step.stop).toBe(expectedStop)
  })

  it('output_item.done 分派：function_call 出 tool / reasoning 出 reasoning_item / message 无产出', () => {
    const { ctx } = mkCtx()
    const st = createResponsesStreamAccum()
    expect(
      typesOf(applyResponsesStreamEvent(st, streamEv({ type: 'response.output_item.done', item: fnCallItem({ id: 'c1', name: 't', arguments: '{}' }) }), ctx).events),
    ).toEqual(['tool'])
    expect(
      typesOf(
        applyResponsesStreamEvent(st, streamEv({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'r', encrypted_content: 'e' } }), ctx).events,
      ),
    ).toEqual(['reasoning_item'])
    expect(typesOf(applyResponsesStreamEvent(st, streamEv({ type: 'response.output_item.done', item: msgItem('m') }), ctx).events)).toEqual([])
  })

  it('顺序不变量：先 text 后 completed 的产出序 = 线上序；回填门因已产出而不重复', () => {
    const { ctx } = mkCtx()
    const st = createResponsesStreamAccum()
    const events: GenEvent[] = []
    for (const event of [
      streamEv({ type: 'response.output_text.delta', delta: '甲' }),
      streamEv({ type: 'response.completed', response: respOf({ output: [msgItem('甲')], usage: usageOf({ input_tokens: 1, output_tokens: 1 }) }) }),
    ]) {
      const step = applyResponsesStreamEvent(st, event, ctx)
      events.push(...step.events)
      if (step.stop) break
    }
    expect(typesOf(events)).toEqual(['text', 'done'])
    expect(events[0]).toEqual({ type: 'text', delta: '甲' })
  })

  it('顺序不变量：output_item.done 已 yield tool 后 completed 不再补发（防双份）', () => {
    const { ctx, rec } = mkCtx()
    const st = createResponsesStreamAccum()
    const events: GenEvent[] = []
    for (const event of [
      streamEv({ type: 'response.output_item.done', item: fnCallItem({ call_id: 'c1', name: 't', arguments: '{}' }) }),
      streamEv({ type: 'response.completed', response: respOf({ output: [fnCallItem({ call_id: 'c1', name: 't', arguments: '{}' })], usage: usageOf({ input_tokens: 1, output_tokens: 1 }) }) }),
    ]) {
      events.push(...applyResponsesStreamEvent(st, event, ctx).events)
    }
    expect(typesOf(events)).toEqual(['tool', 'done'])
    expect(rec.doneRaw).toEqual(['tool_use'])
  })
})
