/**
 * Responses 线流事件的语义单元 —— （全项目源码质量与优雅度评审）：
 * responses-adapter 的 stream 原为一个 232 行 / 圈复杂度 83 / 嵌套 9 层的单函数，
 * 事件解析、增量产出、工具调用累积、终态判决与降级收尾交织在一起。本件把其中
 * 「一个流事件进来 → 产出哪些 GenEvent / 是否终止」的判定逐 arm 拆出，adapter 只留
 * 「建流 → 逐事件交给本件 → 逐条 yield → 降级链」的骨架。
 *
 * 单位划分（与 adapter 侧骨架的对接面）：
 * - 流事件解析：applyResponsesStreamEvent（分发 + 单 arm 判定）；
 * - 增量产出：applyTextDelta / applyReasoningDelta；
 * - 工具调用累积：applyFunctionCallArgsDelta / claimOutputItemFunctionCall（含 idxless
 *   兜底键与兜底 id 序号）/ parseToolArgs（done 臂与伪流回填臂共用的入参归一）；
 * - 收尾与降级判决：applyCompleted（含伪流回填与空产出判错）/ applyIncomplete /
 *   applyFailed / applyStreamError / closeStreamAttempt（截断壳）。
 *
 * 不变量（改此件前先读）：
 * ① 事件处理顺序 = 线上事件序，逐 arm 不可重排——同一 acc 上「先 text 后 done」与
 *    「先 done 后 text」产出不同（工具认领、产出累计、done 时机三者互锁）。
 * ② done / error 的**发射时机**与壳形状全在 stream-finalize（fin）单点，本件只决定
 *    「此刻该不该问 fin 要哪个壳」，不构造壳、不自带幂等门。
 * ③ usage 口径：真 usage 采信与否由 isRealUsage 判（空对象 {}= 无 usage 走估计），
 *    估计一律经 fin.estimateUsage，输入 req 恒为**首发请求**（降级 attempt 不参与折算）。
 * ④ stop=true 表示该 arm 已产出终态（error 壳或 done 后紧跟 return 的语义）——调用方
 *    必须先把 events 全部 yield 完再 return，顺序等价于原实现的「yield 后 return」。
 */
import type OpenAI from 'openai'
import type { GenEvent, GenRequest, TokenUsage } from './types.js'
import type { StreamFinalizer } from './stream-finalize.js'
import { redactSecret } from './redact.js'

/** 本线终止事件四态（无终止事件 = 传输截断） */
export type ResponsesTerminal = 'completed' | 'incomplete' | 'failed' | 'none'

/** 分块拼装中的 function call（item_id / 兜底键 → 累积值） */
export interface ToolAssembly {
  callId: string
  name: string
  args: string
}

/**
 * 单 attempt 的流消费状态。声明在 attempt 循环内每次新建——mid-stream 400 降级续跑时，
 * 上一 attempt 的半截累计（toolAccum / 产出串 / 终止态）不得泄入下一 attempt。
 */
export interface ResponsesStreamAccum {
  /** item_id → { callId, name, args }（每次 attempt 新建） */
  toolAccum: Map<string, ToolAssembly>
  /** 缺 item_id 的 delta 兜底键自增序号 */
  idxlessSeq: number
  /** 兜底键 FIFO 队列——output_item.done 按流式序认领队头 */
  idxlessQueue: string[]
  /** 兜底 tool id 流级单调计数（原 `call_${toolAccum.size}` 随 done 删键非单调） */
  fallbackToolSeq: number
  /** 产出累计（正文/推理 delta + tool 参数串）——无 usage 时按此折算估计入账 */
  outText: string[]
  outToolText: string[]
  /** 终止事件四态（none = 无终止事件 = 传输截断） */
  terminal: ResponsesTerminal
  /** -：本流是否已 yield 过 tool（伪流回填去重门） */
  toolYielded: boolean
  /**
   * text 分支**实际产出**标记——与 outText（计费累计，含
   * reasoning delta）分家：伪流回填门与 hasOutput 判据只认正文实际 yield，
   * 「reasoning 有流出 + text 全缺 + completed 带 message 全文」的网关形态不再误跳回填，
   * reasoning-only 流回归 /「空产出」报错语义（不静默判成功）。
   */
  textYielded: boolean
  /** 加密推理项计数（gen 侧覆盖式收集只留末条，流尾按计数汇总留痕丢弃面） */
  reasoningItemCount: number
}

/** 流事件判定的外部依赖（副作用与终态收口全经参数传入，不做就地闭包捕获）。 */
export interface StreamEventCtx {
  /** 流尾收口单点（done / error 壳唯一出口，见 stream-finalize） */
  fin: StreamFinalizer
  /** 首发请求——usage 估计的 input 折算基准（降级 attempt 的请求不参与折算） */
  req: GenRequest
  /** 模型 id（估计系数查表用） */
  model?: string
}

/** 单事件判定结果：要产出的事件序列（按序 yield）+ 是否随本次产出终止该 attempt。 */
export interface StreamStep {
  events: GenEvent[]
  stop: boolean
}

/** 一词一建：单 attempt 流状态（每次 attempt 起始调用，防上一 attempt 半截累计泄入）。 */
export function createResponsesStreamAccum(): ResponsesStreamAccum {
  return {
    toolAccum: new Map(),
    idxlessSeq: 0,
    idxlessQueue: [],
    fallbackToolSeq: 0,
    outText: [],
    outToolText: [],
    terminal: 'none',
    toolYielded: false,
    textYielded: false,
    reasoningItemCount: 0,
  }
}

/**
 * Responses usage 线格式 → TokenUsage（缺口 12：细节计量）。
 * input_tokens **已含** cached_tokens（与 Chat 线 prompt_tokens 同协议语义），
 * 边界处扣减归一成「inputTokens 不含 cache 读」的统一口径（Anthropic 语义），
 * 下游计价/预算四档分计公式对两协议同时成立。
 */
export function toUsage(u: OpenAI.Responses.ResponseUsage | null | undefined): TokenUsage {
  const cached = u?.input_tokens_details?.cached_tokens
  const reasoning = u?.output_tokens_details?.reasoning_tokens
  return {
    inputTokens: Math.max(0, (u?.input_tokens ?? 0) - (cached ?? 0)),
    outputTokens: u?.output_tokens ?? 0,
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  }
}

/**
 * 空 usage 对象（{} truthy 但无计量字段）等价「无 usage」——
 * 原判定 `r.usage ? toUsage(r.usage) : estimate` 让 {} 走 toUsage 得 0/0 假计量，
 * 绕过本线的估计兜底，预算闸/成本对非标网关系统性偏低。对齐 openai 线
 * isRealUsage 口径：至少一个计量字段在位才采信，否则走估计（标 estimated）。
 */
export function isRealUsage(u: OpenAI.Responses.ResponseUsage | null | undefined): boolean {
  return u !== null && u !== undefined && (u.input_tokens !== undefined || u.output_tokens !== undefined)
}

/**
 * 产出累计折算估计——input 按请求字符折算；output 按产出累计
 * 折算，toolAccum 未认领残留（incomplete 截断在途的调用参数）一并并入（折算体在
 * fin.estimateUsage 单点）。
 */
export function estimateAttemptUsage(st: ResponsesStreamAccum, ctx: StreamEventCtx): TokenUsage {
  return ctx.fin.estimateUsage({
    req: ctx.req,
    model: ctx.model,
    outText: st.outText,
    outToolText: st.outToolText,
    pendingToolText: [...st.toolAccum.values()].map((t) => t.name + t.args),
  })
}

/** 真 usage 采信 / 缺失走估计（口径见 isRealUsage 注）。 */
export function resolveUsage(
  st: ResponsesStreamAccum,
  u: OpenAI.Responses.ResponseUsage | null | undefined,
  ctx: StreamEventCtx,
): TokenUsage {
  return isRealUsage(u) ? toUsage(u) : estimateAttemptUsage(st, ctx)
}

/**
 * 工具入参归一（output_item.done 臂与伪流回填臂同款）：空串 → {}；
 * （GLM-5.3 修复批）：合法 JSON 非对象（数字/字符串/数组/
 * 布尔——模型偶发裸标量参数形态）同兜 {_raw}——原样透出入库后，跨协议换供方回放
 * Anthropic 线必 400（input 契约是 object；anthropic-adapter 侧另有归一兜底，此处
 * 产源头窄前置）；畸形 JSON 同落 {_raw}。
 */
export function parseToolArgs(raw: string): unknown {
  try {
    const parsed = raw ? JSON.parse(raw) : {}
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : { _raw: raw }
  } catch {
    return { _raw: raw }
  }
}

/** 正文增量：产出累计 + textYielded 置位 + 透出（顺序即产出顺序）。 */
export function applyTextDelta(st: ResponsesStreamAccum, delta: string | undefined): GenEvent[] {
  if (!delta) return []
  st.outText.push(delta) // 产出累计
  st.textYielded = true // 正文实际 yield 标记（回填门/hasOutput 判据）
  return [{ type: 'text', delta }]
}

/**
 * 推理增量（缺口 4）：reasoning_text.delta（OpenAI/grok 原生文本）与
 * reasoning_summary_text.delta（OpenAI summary）都归一到 reasoning 事件。
 * 计费面进 outText（推理 token 也是真实消耗，学 openai 线），但**不置** textYielded
 * （正文面判据，见 ResponsesStreamAccum.textYielded 注）。
 */
export function applyReasoningDelta(st: ResponsesStreamAccum, delta: string | undefined): GenEvent[] {
  if (!delta) return []
  st.outText.push(delta) // 产出累计（学 openai 线）
  return [{ type: 'reasoning', delta }]
}

/**
 * function_call_arguments.delta：分片累积。
 * （总六十五轮）：key 决策——有 item_id 原样；缺失时续片归并最近兜底键（其 accum
 * 仍在），否则开新自增兜底键入队（供 done 按序认领）——此前并入同一空键会把多个调用的
 * 参数串调。
 */
export function applyFunctionCallArgsDelta(
  st: ResponsesStreamAccum,
  event: OpenAI.Responses.ResponseFunctionCallArgumentsDeltaEvent,
): void {
  const lastPending = st.idxlessQueue.length > 0 ? st.idxlessQueue[st.idxlessQueue.length - 1]! : undefined
  let key: string
  if (typeof event.item_id === 'string' && event.item_id !== '') {
    key = event.item_id
  } else if (lastPending !== undefined && st.toolAccum.has(lastPending)) {
    key = lastPending
  } else {
    key = `no-item-id-${++st.idxlessSeq}`
    st.idxlessQueue.push(key)
  }
  const assembled = st.toolAccum.get(key) ?? { callId: '', name: '', args: '' }
  if (event.delta) assembled.args += event.delta
  st.toolAccum.set(key, assembled)
}

/**
 * output_item.done 的 function_call 臂：认领累积（直接键未命中 → FIFO 队头）→ 补全
 * callId/name/args → 计入产出累计 → 归一入参 → 返回 tool 事件。
 * -：done 之前直接 yield tool（probe break-on-done 语义）。
 * 权威值优先——done 事件携带的 item.arguments 是服务端完整串；
 * 原 `acc.args || item.arguments` 让 delta 累计优先，网关 delta 丢片时残缺 JSON 静默
 * 回退空对象 {}（工具参数丢失）。done 项完整值在位时覆盖累计，缺失才回落累计。
 */
export function claimOutputItemFunctionCall(
  st: ResponsesStreamAccum,
  item: OpenAI.Responses.ResponseFunctionToolCall,
): GenEvent {
  const itemId = item.id ?? item.call_id ?? ''
  // 直接键未命中（delta 缺 item_id 走了兜底键）→ FIFO 队列按流式序认领队头
  let accKey = itemId
  let assembled = st.toolAccum.get(itemId)
  if (!assembled && st.idxlessQueue.length > 0) {
    accKey = st.idxlessQueue.shift()!
    assembled = st.toolAccum.get(accKey)
  }
  if (!assembled) assembled = { callId: '', name: '', args: '' }
  // done 项 call_id/id 双缺（只兜了 delta 缺 item_id 的
  // 拼装面）→ 空 callId 回灌历史成 tool_use{id:''}，下轮组装 function_call_output
  // {call_id:''} 严格网关 400。兜底序号 id 对齐另两线。
  // 序号流级单调（原 map.size 非单调，同流重号）
  assembled.callId = item.call_id ?? (itemId || `call_${st.fallbackToolSeq++}`)
  assembled.name = item.name
  assembled.args = item.arguments || assembled.args || ''
  st.toolAccum.delete(accKey)
  st.outToolText.push(assembled.name + assembled.args) // tool 参数计入产出累计
  st.toolYielded = true
  return { type: 'tool', id: assembled.callId, name: assembled.name, input: parseToolArgs(assembled.args) }
}

/**
 * output_item.done 的 reasoning 臂（缺口 11 后半）：加密推理项透出
 * （gen 收集入 GenResult → chat 存回）。：计数在消费侧覆盖留存之前——多条时
 * GenResult 只留末条，流尾按计数汇总留痕。
 */
export function claimOutputItemReasoning(
  st: ResponsesStreamAccum,
  item: OpenAI.Responses.ResponseReasoningItem,
): GenEvent[] {
  if (!item.encrypted_content) return []
  st.reasoningItemCount++
  return [
    { type: 'reasoning_item', encrypted: item.encrypted_content, ...(item.id ? { itemId: item.id } : {}) },
  ]
}

/** 伪流式网关的 message 项正文回填（无 text delta 流出时，completed 的 message 项是唯一产出）。 */
function backfillCompletedText(st: ResponsesStreamAccum, output: readonly OpenAI.Responses.ResponseOutputItem[] | undefined): GenEvent[] {
  if (st.textYielded) return []
  const backfill: string[] = []
  for (const it of output ?? []) {
    if (it.type !== 'message') continue
    for (const part of it.content ?? []) {
      if (part.type === 'output_text' && part.text) backfill.push(part.text)
    }
  }
  if (backfill.length === 0) return []
  const full = backfill.join('')
  st.outText.push(full) // 产出累计口径一致
  st.textYielded = true // 回填即产出，防双回填
  return [{ type: 'text', delta: full }]
}

/**
 * 修复批（C103）：伪流回填对称扩展 function_call 项——伪流网关
 * completed.output 只含 function_call（无 output_item.done 流出）时原实现无 tool 事件，
 * hasOutput 因 function_call 在场判 true → 正常 emitDone，工具型调用方拿 input:null
 * 报「产出为空或非对象」。字段形状/兜底与 output_item.done 臂同款（call_id 缺失序号 id、
 * arguments 完整串优先、合法 JSON 非对象/畸形 JSON 同落 {_raw}），计费累计同口径；
 * 正常流已 yield 过 tool（toolYielded）时不回填（防重复）。
 */
function backfillCompletedToolCalls(st: ResponsesStreamAccum, output: readonly OpenAI.Responses.ResponseOutputItem[] | undefined): GenEvent[] {
  if (st.toolYielded) return []
  const events: GenEvent[] = []
  for (const it of output ?? []) {
    if (it.type !== 'function_call') continue
    const args = it.arguments || ''
    st.outToolText.push(it.name + args) // tool 参数计入产出累计
    st.toolYielded = true
    events.push({ type: 'tool', id: it.call_id ?? `call_${st.fallbackToolSeq++}`, name: it.name, input: parseToolArgs(args) })
  }
  return events
}

/**
 * response.completed：伪流回填（text + tool）→ 空产出判错 / 正常 done。
 * 判空（EMPTY_RESPONSE 语义，学 dsh）：completed 但无 message/function_call 产出且
 * 未 yield 过 tool → 退化完成判错不判成功；补「本流已实际流出内容」
 * 判据（网关省略 completed 的 output 数组但 delta 已流出正文时原判据误判空产出且
 * retryable:false 不重试，token 白烧）—— 起正文面判据取 textYielded
 * （outText 含 reasoning delta，不作产出判据）。
 * 空产出 error 随错上抛 usage（/口径，真值在手即真值、否则走估计兜底）。
 */
export function applyCompleted(
  st: ResponsesStreamAccum,
  response: OpenAI.Responses.Response,
  ctx: StreamEventCtx,
): StreamStep {
  st.terminal = 'completed'
  const events = [
    ...backfillCompletedText(st, response.output),
    ...backfillCompletedToolCalls(st, response.output),
  ]
  const hasOutput =
    st.toolYielded || st.textYielded || Boolean(response.output?.some((it) => it.type === 'message' || it.type === 'function_call'))
  if (!hasOutput) {
    events.push(ctx.fin.terminalError('模型返回空产出（Responses completed 无内容项）', resolveUsage(st, response.usage, ctx)))
    return { events, stop: true }
  }
  // completed 无 usage（网关不回 usage）→ 估计入账兜底，estimated 标记估计口径
  // （修复前 toUsage(null) 恒 0/0 入账）
  const done = ctx.fin.done(resolveUsage(st, response.usage, ctx), st.toolYielded ? 'tool_use' : 'stop')
  if (done) events.push(done)
  return { events, stop: false }
}

/**
 * response.incomplete：max_output_tokens → done(max_tokens)；其余原因不得伪装成正常
 * stop（缺口 2：content_filter 等）——终态 error 且随错上抛已发生消耗（口径）。
 */
export function applyIncomplete(
  st: ResponsesStreamAccum,
  response: OpenAI.Responses.Response,
  ctx: StreamEventCtx,
): StreamStep {
  st.terminal = 'incomplete'
  const reason = response.incomplete_details?.reason
  if (reason === 'max_output_tokens') {
    // incomplete 同款估计兜底（截断场景网关更常缺 usage）
    const done = ctx.fin.done(resolveUsage(st, response.usage, ctx), 'max_tokens')
    return { events: done ? [done] : [], stop: false }
  }
  return {
    events: [ctx.fin.terminalError(`响应不完整：${reason ?? 'unknown'}`, resolveUsage(st, response.usage, ctx))],
    stop: true,
  }
}

/**
 * response.failed：终态 error 不发 done（缺口 1，此前落穿被流结束兜底伪装成
 * done{stop, 0/0}）；message 脱敏后带上。
 * + completed / incomplete(max_tokens) 已 emitDone 后网关仍补发
 * failed/error（流尾抖动形态）——terminal 已置即忽略，done 已发的回合不被翻转。
 * 流中 failed/error 恒 retryable:false，与另两线（HTTP status → 决策表）
 * 不对称系有意保守——流中事件缺 HTTP status，无法可靠判可重试；保守终态防半截流反复
 * 重试成风暴。不修。
 * code：流中 failed 属协议层异常，无 HTTP status 可归因 → 与 toErrorEvent 兜底同码
 * 'PROTOCOL'（vendor 的 response.error.code 是自由字符串，无 GenErrorCode 映射表，不猜）。
 */
export function applyFailed(
  st: ResponsesStreamAccum,
  response: OpenAI.Responses.Response,
  ctx: StreamEventCtx,
): StreamStep {
  if (st.terminal !== 'none') return { events: [], stop: false }
  st.terminal = 'failed'
  const msg = response.error?.message ?? `response.failed (status=${response.status ?? 'unknown'})`
  return { events: [ctx.fin.terminalError(redactSecret(msg), resolveUsage(st, response.usage, ctx), 'PROTOCOL')], stop: true }
}

/** 流中 error 事件（网关 mid-stream error）——同 failed 处理（守卫与 code 口径同上）；无 response 载荷，usage 走估计兜底（标 estimated）。 */
export function applyStreamError(
  st: ResponsesStreamAccum,
  event: OpenAI.Responses.ResponseErrorEvent,
  ctx: StreamEventCtx,
): StreamStep {
  if (st.terminal !== 'none') return { events: [], stop: false }
  st.terminal = 'failed'
  return { events: [ctx.fin.terminalError(redactSecret(event.message ?? '流中错误事件'), estimateAttemptUsage(st, ctx), 'PROTOCOL')], stop: true }
}

/**
 * ── 流事件解析（单入口分发）────────────────────────────────────────────────
 * 网关偏差挂点（缺口 18）：响应侧缺字段时在此入口加 per-family normalize。
 * 未知事件类型静默跳过（本线只消费上述 arm；其余 SDK 事件无产出语义）。
 */
export function applyResponsesStreamEvent(
  st: ResponsesStreamAccum,
  event: OpenAI.Responses.ResponseStreamEvent,
  ctx: StreamEventCtx,
): StreamStep {
  switch (event.type) {
    case 'response.output_text.delta':
      return { events: applyTextDelta(st, event.delta), stop: false }
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta':
      return { events: applyReasoningDelta(st, event.delta), stop: false }
    case 'response.function_call_arguments.delta':
      applyFunctionCallArgsDelta(st, event)
      return { events: [], stop: false }
    case 'response.output_item.done': {
      const item = event.item
      if (item.type === 'function_call') {
        return { events: [claimOutputItemFunctionCall(st, item)], stop: false }
      }
      if (item.type === 'reasoning') {
        return { events: claimOutputItemReasoning(st, item), stop: false }
      }
      return { events: [], stop: false }
    }
    case 'response.completed':
      return applyCompleted(st, event.response, ctx)
    case 'response.incomplete':
      return applyIncomplete(st, event.response, ctx)
    case 'response.failed':
      return applyFailed(st, event.response, ctx)
    case 'error':
      return applyStreamError(st, event, ctx)
    default:
      return { events: [], stop: false }
  }
}

/**
 * ── 流尾收尾（循环自然结束后）────────────────────────────────────────────────
 * 截断判定必须在 toolAccum 清空**之前**（残留调用参数计入产出折算，清后即丢）。
 * 订正：删除「无 completed 兜底发 done{0/0,stop}」——无终止事件 =
 * 传输截断，报错不发 done；截断路径原「残留 flush」循环物理不可达（残留条目的 name
 * 只在 output_item.done 分支赋值且随即 delete，恒空）已删除，未到 done 的调用不交出，
 * 其参数仅经截断壳的 usage 计入产出——如实记档。
 * done 之后不再 flush 残留 tool（已在 done 的回合补发 tool 违反
 * 「done 收尾」契约）——本函数只在未 done 分支产出截断壳，三线对齐。
 * 返回 discardedReasoningItems = 被覆盖丢弃的加密推理项条数（>0 时调用方留痕）。
 */
export function closeStreamAttempt(
  st: ResponsesStreamAccum,
  ctx: StreamEventCtx,
): { events: GenEvent[]; discardedReasoningItems: number } {
  const truncated = st.terminal === 'none' ? ctx.fin.truncatedError(estimateAttemptUsage(st, ctx)) : null
  st.toolAccum.clear()
  return {
    events: truncated ? [truncated] : [],
    discardedReasoningItems: st.reasoningItemCount > 1 ? st.reasoningItemCount - 1 : 0,
  }
}
