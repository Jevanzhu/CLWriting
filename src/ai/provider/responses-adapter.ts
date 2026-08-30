/**
 * OpenAI Responses API 适配器（/v1/responses）——gpt-5 / grok 深度用线。
 *
 * 骨架自 84e370b^ 历史找回（曾随 Z-P2-1 误判停用删除，2026-08-17 启用批回接），
 * 按《Responses格式适配-实现方案》R1-R4 重写：
 * - R1 终止事件契约（学 dsh stream.ts）：流必须以 completed / incomplete / failed 之一
 *   收尾——failed/error 事件 → error 不发 done；无终止事件 → 传输截断（可重试）；
 *   completed 零产出 → 判错不判成功；incomplete 非 max_output_tokens 原因 → error。
 * - R2b 参数翻译全量走 responsesQuirksFor 视图（tool_choice 三值 / effort 三落点 /
 *   structuredMode / store:false 隐私下发 / include encrypted_content）。
 * - R3 回合状态：assistant 轮 reasoning 块按 echoReasoning 回插（gpt=encrypted 维持
 *   推理延续）；usage 细节计量（cached_tokens / reasoning_tokens）。
 * - R4 降级记忆照 openai-adapter 当前实现（lookupDegraded 新鲜读 + persistDegraded 双写）。
 *
 * 与 Chat Completions（openai-adapter.ts）并存，由 registry 按 protocol 路由。
 * 线格式关键差异：input 数组（developer 角色）而非 messages；max_output_tokens；
 * text.format 结构化；流事件 response.* 命名；tool_choice 指名为扁平 {type:'function',name}。
 */
import OpenAI from 'openai'
import type {
  ProviderConf,
  GenRequest,
  GenEvent,
  ModelProvider,
  TokenUsage,
  ToolDef,
  ContentBlock,
} from './types.js'
import type { ProviderStore } from './store.js'
import { modelConfOf } from './store.js'
import { redactSecret } from './redact.js'
import { responsesQuirksFor } from './model-quirks.js'
import { makeToErrorEvent, buildDegradeAttempts, isMidChain400, markStructuredDegrade } from './adapter-errors.js'
import { estimateInputTokens, estimateOutputTokens } from './usage-estimate.js'
import { log } from '../../log/index.js'

/** SDK 异常 → GenEvent.error：公共工厂实现（adapter-errors），此处只贴本线错误类与 label */
const toErrorEvent = makeToErrorEvent({
  APIError: OpenAI.APIError,
  APIUserAbortError: OpenAI.APIUserAbortError,
  APIConnectionError: OpenAI.APIConnectionError,
  label: 'OpenAI API',
})

/** tool_use 往返：user 的 tool_result → function_call_output 输出项（call_id 关联） */
function toolOutputItem(toolUseId: string, content: string): Record<string, unknown> {
  return { type: 'function_call_output', call_id: toolUseId, output: content }
}

/**
 * GenRequest → /v1/responses 请求体（R2b：全量翻译走 responsesQuirksFor 视图）。
 *
 * 网关偏差挂点（缺口 18，初版不建改写框架）：某网关 400 或缺字段时，按 cherry ark.ts
 * 模式（请求剥 include / 响应补 annotations）在此尾部加 per-family patch。
 */
function toParams(conf: ProviderConf, req: GenRequest): Record<string, unknown> {
  const q = responsesQuirksFor(conf.model ?? '')
  const rw = q.responsesWire

  const input: Record<string, unknown>[] = []
  // 系统指令 → developer 角色（OpenAI 新约定；角色 'system' 仍兼容但官方建议 developer）
  if (req.systemPrompt) {
    input.push({ role: 'developer', content: req.systemPrompt })
  }
  // user/assistant 消息：纯文本直传；block 数组展开（text / tool_use / tool_result 往返）
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      input.push({ role: m.role, content: m.content })
      continue
    }
    const textParts: string[] = []
    const toolUseItems: Record<string, unknown>[] = []
    // R72-12（二十轮 A-3）：user 分支与 assistant 同构——tool_result 也收集后统一输出，
    // 消除「text+tool_result 混排 user 消息」的块序颠倒（当前链路 tool_result 独占
    // user 消息不触发，防御性对齐）
    const toolResultItems: Record<string, unknown>[] = []
    // R3（缺口 11）：assistant 轮 reasoning 块按 echoReasoning 分档——encrypted 回插
    // 加密推理项（置于该 assistant 的 text/function_call 之前，Responses 语义：reasoning
    // item 先于其产出的 function_call）；strip/none 跳过（grok CLI 代理拒绝回传 / 未测）。
    const reasoningItems: Record<string, unknown>[] = []
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'text') textParts.push(b.text)
      else if (b.type === 'reasoning') {
        // id 缺失的 reasoning item 回传会被拒——双条件才回插
        if (rw.echoReasoning === 'encrypted' && b.encrypted && b.itemId) {
          reasoningItems.push({ type: 'reasoning', id: b.itemId, encrypted_content: b.encrypted, summary: [] })
        }
      } else if (b.type === 'tool_use') {
        toolUseItems.push({
          type: 'function_call',
          call_id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input),
        })
      } else if (b.type === 'tool_result') {
        toolResultItems.push(toolOutputItem(b.toolUseId, b.content))
      }
    }
    if (m.role === 'assistant') {
      input.push(...reasoningItems)
      if (textParts.length > 0) input.push({ role: 'assistant', content: textParts.join('') })
      input.push(...toolUseItems)
    } else {
      if (textParts.length > 0) input.push({ role: 'user', content: textParts.join('') })
      input.push(...toolResultItems)
    }
  }

  const params: Record<string, unknown> = {
    // B-P2-6：conf.model 可能为 null/undefined（未选模型时），兜底空串防 SDK 报参数错
    model: conf.model ?? '',
    input,
    stream: true,
    // 缺口 9：OpenAI 默认 store=true（响应留存 30 天）——书稿全文上行场景必须显式 false
    //（cherry openai 线无条件 store:false 印证）；DeepSeek 恒 false 天然兼容、grok 无状态。
    store: false,
  }
  // 阶段 14 §7.2：调用方显式 cap（req.maxTokens）优先；其次用户模型行覆盖；仍无 → 不发（同 OpenAI 线行为）
  const tokenCap = req.maxTokens ?? modelConfOf(conf)?.maxTokens
  if (tokenCap) params['max_output_tokens'] = tokenCap

  // 缺口 6：effort 落点按 rw.effortWire 分家（档位映射复用基表 reasoningEffort——
  // gpt/grok 透传、deepseek trimEffort）
  if (req.effort) {
    const effort = q.reasoningEffort(req.effort)
    if (effort) {
      if (rw.effortWire === 'reasoning-effort') params['reasoning'] = { effort }
      else if (rw.effortWire === 'reasoning_effort') params['reasoning_effort'] = effort
      else params['output_config'] = { effort }
    }
  }

  if (req.tools?.length) {
    params['tools'] = req.tools.map(toResponsesTool)
    // 缺口 11 前半：store:false + 工具调用时，OpenAI 靠 include 让响应携带加密推理项
    //（下轮回传维持推理状态，codex 后端强制此机制）
    if (rw.echoReasoning === 'encrypted') {
      params['include'] = ['reasoning.encrypted_content']
    }
  }

  // 缺口 5：tool_choice 翻译（学 openai-adapter 分档写法；Responses 指名为扁平
  // {type:'function',name}，非 Chat 的 {type, function:{name}}）——
  // named → any→required / tool→指名 / auto→auto；
  // required（deepseek：无指名）→ 强制意图一律 required；auto → 仅 auto 意图发。
  if (req.toolChoice) {
    if (rw.toolChoiceMode === 'named') {
      if (req.toolChoice === 'any') params['tool_choice'] = 'required'
      else if (req.toolChoice === 'tool' && req.toolName) params['tool_choice'] = { type: 'function', name: req.toolName }
      else if (req.toolChoice === 'auto') params['tool_choice'] = 'auto'
    } else if (rw.toolChoiceMode === 'required') {
      if (req.toolChoice === 'any' || req.toolChoice === 'tool') params['tool_choice'] = 'required'
      else if (req.toolChoice === 'auto') params['tool_choice'] = 'auto'
    } else {
      if (req.toolChoice === 'auto') params['tool_choice'] = 'auto'
      // 'any'/'tool' → 保守不发（prompt 引导 + 契约层校验重试兜底）
    }
    // W0 契约「一轮最多一个工具调用」（RB-AI-P2-4 对齐 Chat/Anthropic 线）
    if (q.parallelControl) params['parallel_tool_calls'] = false
  }

  // 缺口 7：structuredMode 消费——json_schema 才发 text.format；json_object/none 不发
  //（prompt 约束兜底，与 Chat 线口径一致，deepseek 避免首发 400 再降级）
  if (req.structured?.schema && rw.structuredMode === 'json_schema') {
    params['text'] = {
      format: {
        type: 'json_schema',
        name: 'output',
        schema: req.structured.schema,
        strict: true,
      },
    }
  }

  // 缺口 13：text.verbosity（low/medium/high）留位不发——rw.verbosity===true 的家
  //（gpt）未来才可能发，初版不发保守。
  // 缺口 10：stop_sequences → 无对应参数，静默忽略（探测 details 已提示）。

  return params
}

function toResponsesTool(tool: ToolDef): Record<string, unknown> {
  return { type: 'function', name: tool.name, description: tool.description ?? '', parameters: tool.input_schema }
}

/**
 * Responses usage 线格式 → TokenUsage（R3 缺口 12：细节计量）。
 * M-1：input_tokens **已含** cached_tokens（与 Chat 线 prompt_tokens 同协议语义），
 * 边界处扣减归一成「inputTokens 不含 cache 读」的统一口径（Anthropic 语义），
 * 下游计价/预算四档分计公式对两协议同时成立。
 */
function toUsage(u: OpenAI.Responses.ResponseUsage | null | undefined): TokenUsage {
  const cached = u?.input_tokens_details?.cached_tokens
  const reasoning = u?.output_tokens_details?.reasoning_tokens
  return {
    inputTokens: Math.max(0, (u?.input_tokens ?? 0) - (cached ?? 0)),
    outputTokens: u?.output_tokens ?? 0,
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  }
}

export function createOpenAIResponsesProvider(
  conf: ProviderConf,
  client?: OpenAI,
  store?: ProviderStore,
  userDataPath?: string,
): ModelProvider {
  // R31-5（三十一轮）：SDK 内建重试关闭（runner 重试层是唯一重试决策方，见 openai-adapter 同注）
  const c = client ?? new OpenAI({ apiKey: conf.apiKey, baseURL: normalizeBaseUrl(conf.baseUrl), maxRetries: 0 })
  const q = responsesQuirksFor(conf.model ?? '')

  return {
    conf,

    async *stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> {
      let doneEmitted = false
      let degraded = false // Z-12：成功建流是否用了降级参数面（emitDone 闭包读）
      // Q-13（第十五轮）：resolve 后终值随 done 透出（与 toParams 的 tokenCap 同链：
      // 调用方 cap → 模型行；无兜底不发 → undefined）
      const resolvedMaxTokens = req.maxTokens ?? modelConfOf(conf)?.maxTokens
      const emitDone = (usage: TokenUsage, stopReason: string): GenEvent | null => {
        if (doneEmitted) return null
        doneEmitted = true
        return { type: 'done', usage, stopReason, resolvedMaxTokens, ...(degraded ? { degraded: true } : {}) }
      }

      // 400 降级链（缺口 14）：structured → tools 两级剥除；attempts 构造 / 400 续跑闸 /
      // 记忆写入走 adapter-errors 公共实现（「连接期可安全重试、流中不重跑」约定见其注释）。
      // 判据 q.structuredMode 是 responsesQuirksFor 的 responsesWire 覆盖值（与 text.format
      // 发射同源）；mode='json_object' 时 text.format 不发但链仍保留（照搬原实现口径）。
      // R30-4（三十轮）：携来源 userDataPath——降级记忆读/写按显式 path 分发
      const plan = buildDegradeAttempts(req, q.structuredMode, conf, store, userDataPath)

      try {
        let lastErr: unknown = null
        for (const attempt of plan.attempts) {
          // ii-1：本 attempt 是否已开始消费流。降级续跑只对「建连期 400」安全——
          // 已收到事件后换参数面重跑会让消费者收到重复增量，一律转终态错误。
          let consumedAny = false
          try {
            const stream = await c.responses.create(
              toParams(conf, attempt) as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
              { signal },
            )
            markStructuredDegrade(plan, attempt, store)
            // Z-12（第五十八轮）：成功建流用的是非首发（降级）参数面 → done 事件带 degraded
            // A3（五十九轮）：判据并入降级记忆命中——基准改 plan.original（记忆命中时
            // attempts[0] 已是剥除版，旧判据对首发恒 false，记忆命中路径漏标 degraded）
            degraded = attempt !== plan.original

            // 分块拼装中的 function call：item_id → { callId, name, args }
            // （P2 复审：声明在 attempt 循环内每次新建——mid-stream 400 降级续跑时，
            // 上一 attempt 的半截拼装不得泄入下一 attempt（对齐 openai-adapter 结构））
            const toolAccum = new Map<string, { callId: string; name: string; args: string }>()
            // R65-10（总六十五轮）：缺 item_id 的 delta 兜底聚合（与 R65-9 同族）——此前
            // 并入同一空键会把多个调用的参数串调；改自增兜底键 + FIFO 队列：
            // output_item.done 按流式序认领队头（Responses 流中项的 added→delta→done
            // 顺序相邻，队头即当前项），续片归并最近兜底键
            let idxlessSeq = 0
            const idxlessQueue: string[] = []
            // A-5（二十九轮）：本 attempt 加密推理项计数——gen.ts 对 reasoning_item 是
            // 覆盖式收集（只留末条），多条时前 N-1 条被丢弃；流尾按计数一次性汇总留痕
            //（逐条 warn 会刷屏，丢弃必须可感知 → 汇总一条）
            let reasoningItemCount = 0
            // R74-1（二十二轮批 A）：产出累计（文本/推理 delta 串联 + tool 参数串）——
            // completed/incomplete 无 usage 时按此折算估计入账（usage-estimate.ts 同源
            // 系数，对齐 openai/anthropic 线 R73-1 形态），不再按 0/0 入账（预算闸对
            // 不回 usage 的 Responses 端点永不生效）
            const outText: string[] = []
            const outToolText: string[] = []
            // R74-1：终止事件无 usage 的估计兜底——input 按请求字符折算；output 按产出
            // 累计折算，toolAccum 未认领残留（incomplete 截断在途的调用参数）一并并入
            const estimateDoneUsage = (): TokenUsage => {
              const toolText = [...outToolText]
              for (const [, t] of toolAccum) toolText.push(t.name + t.args)
              return {
                inputTokens: estimateInputTokens(req, conf.model ?? undefined),
                outputTokens: estimateOutputTokens(outText.join('') + toolText.join(''), conf.model ?? undefined),
                estimated: true,
              }
            }

            // ── R1 事件循环：终止事件契约 ──
            // 流必须以 completed / incomplete / failed 之一收尾；无终止事件 = 传输截断。
            // 网关偏差挂点（缺口 18）：响应侧缺字段时在此入口加 per-family normalize。
            let terminal: 'completed' | 'incomplete' | 'failed' | 'none' = 'none'
            let toolYielded = false
            for await (const event of stream) {
              consumedAny = true
              switch (event.type) {
                case 'response.output_text.delta': {
                  if (event.delta) {
                    outText.push(event.delta) // R74-1：产出累计
                    yield { type: 'text', delta: event.delta }
                  }
                  break
                }
                // 缺口 4：reasoning 增量——reasoning_text.delta（OpenAI/grok 原生文本）
                // 与 reasoning_summary_text.delta（OpenAI summary）都归一到 reasoning 事件
                case 'response.reasoning_text.delta':
                case 'response.reasoning_summary_text.delta': {
                  if (event.delta) {
                    outText.push(event.delta) // R74-1：产出累计（推理 token 也是真实计费面，学 openai 线）
                    yield { type: 'reasoning', delta: event.delta }
                  }
                  break
                }
                case 'response.function_call_arguments.delta': {
                  // R65-10：key 决策——有 item_id 原样；缺失时续片归并最近兜底键
                  //（其 accum 仍在），否则开新自增兜底键入队（供 done 按序认领）
                  const lastPending = idxlessQueue.length > 0 ? idxlessQueue[idxlessQueue.length - 1]! : undefined
                  let key: string
                  if (typeof event.item_id === 'string' && event.item_id !== '') {
                    key = event.item_id
                  } else if (lastPending !== undefined && toolAccum.has(lastPending)) {
                    key = lastPending
                  } else {
                    key = `no-item-id-${++idxlessSeq}`
                    idxlessQueue.push(key)
                  }
                  const acc = toolAccum.get(key) ?? { callId: '', name: '', args: '' }
                  if (event.delta) acc.args += event.delta
                  toolAccum.set(key, acc)
                  break
                }
                case 'response.output_item.done': {
                  const item = event.item
                  if (item.type === 'function_call') {
                    // P1-S5：done 之前直接 yield tool（probe break-on-done 语义）
                    const itemId = item.id ?? item.call_id ?? ''
                    // R65-10：直接键未命中（delta 缺 item_id 走了兜底键）→ FIFO 队列
                    // 按流式序认领队头
                    let accKey = itemId
                    let acc = toolAccum.get(itemId)
                    if (!acc && idxlessQueue.length > 0) {
                      accKey = idxlessQueue.shift()!
                      acc = toolAccum.get(accKey)
                    }
                    if (!acc) acc = { callId: '', name: '', args: '' }
                    acc.callId = item.call_id ?? itemId
                    acc.name = item.name
                    acc.args = acc.args || item.arguments || ''
                    toolAccum.delete(accKey)
                    outToolText.push(acc.name + acc.args) // R74-1：tool 参数计入产出累计
                    let input: unknown
                    try {
                      input = acc.args ? JSON.parse(acc.args) : {}
                    } catch {
                      input = { _raw: acc.args }
                    }
                    toolYielded = true
                    yield { type: 'tool', id: acc.callId, name: acc.name, input }
                  } else if (item.type === 'reasoning' && item.encrypted_content) {
                    // R3（缺口 11 后半）：加密推理项透出（gen 收集入 GenResult → chat 存回）
                    reasoningItemCount++ // A-5：覆盖前计数（消费侧只留末条）
                    yield { type: 'reasoning_item', encrypted: item.encrypted_content, ...(item.id ? { itemId: item.id } : {}) }
                  }
                  break
                }
                case 'response.completed': {
                  terminal = 'completed'
                  const r = event.response
                  // R1 判空（EMPTY_RESPONSE 语义，学 dsh）：completed 但无 message/function_call
                  // 产出且未 yield 过 tool → 退化完成判错不判成功。判据限定 output item 类型，
                  // probe（「回复OK」）与结构化产出（message item）不受影响。
                  // R26-4（二十六轮）：补本流已实际流出内容判据——网关省略 completed 的
                  // output 数组（响应缺字段形态，文件头缺口 18 自认）但 delta 已流出正文时，
                  // 原判据误判「空产出」且 retryable:false 不重试，token 白烧。outText 是
                  // R74-1 为估计入账收集的本流累计，就在手边。
                  const hasOutput =
                    toolYielded || outText.length > 0 || Boolean(r.output?.some((it) => it.type === 'message' || it.type === 'function_call'))
                  if (!hasOutput) {
                    yield { type: 'error', message: '模型返回空产出（Responses completed 无内容项）', retryable: false }
                    return
                  }
                  // R74-1：completed 无 usage（网关不回 usage）→ 估计入账兜底，
                  // estimated 标记估计口径（修复前 toUsage(null) 恒 0/0 入账）
                  const ev = emitDone(r.usage ? toUsage(r.usage) : estimateDoneUsage(), toolYielded ? 'tool_use' : 'stop')
                  if (ev) yield ev
                  break
                }
                case 'response.incomplete': {
                  terminal = 'incomplete'
                  const r = event.response
                  const reason = r.incomplete_details?.reason
                  if (reason === 'max_output_tokens') {
                    // R74-1：incomplete 同款估计兜底（截断场景网关更常缺 usage）
                    const ev = emitDone(r.usage ? toUsage(r.usage) : estimateDoneUsage(), 'max_tokens')
                    if (ev) yield ev
                  } else {
                    // R1（缺口 2）：content_filter 等其他截断原因不得伪装成正常 stop
                    yield {
                      type: 'error',
                      message: `响应不完整：${reason ?? 'unknown'}`,
                      retryable: false,
                    }
                    return
                  }
                  break
                }
                case 'response.failed': {
                  terminal = 'failed'
                  // R30-9（三十轮）登记维持：流中 failed/error 事件恒 retryable:false，与
                  // 另两线（HTTP status → 决策表）不对称系有意保守——流中事件缺 HTTP
                  // status，无法可靠判可重试；保守终态防半截流反复重试成风暴。不修。
                  // R1（缺口 1）：failed → error 不发 done（此前落穿被流结束兜底伪装成
                  // done{stop, 0/0}）；message 脱敏后带上。
                  // code：流中 failed 属协议层异常，无 HTTP status 可归因 → 与 toErrorEvent
                  // 兜底同码 'PROTOCOL'（vendor 的 response.error.code 是自由字符串，无
                  // GenErrorCode 映射表，不猜）
                  const msg = event.response.error?.message ?? `response.failed (status=${event.response.status ?? 'unknown'})`
                  yield { type: 'error', message: redactSecret(msg), retryable: false, code: 'PROTOCOL' }
                  return
                }
                case 'error': {
                  // SDK 流中错误事件（网关 mid-stream error）——同 failed 处理，code 同上
                  terminal = 'failed'
                  yield { type: 'error', message: redactSecret(event.message ?? '流中错误事件'), retryable: false, code: 'PROTOCOL' }
                  return
                }
              }
            }

            // 循环后兜底改写（R1 缺口 3）：toolAccum 残留 flush 保留（有 delta 无
            // output_item.done 的截断场景，有 name 才构成完整调用）；删除「无 completed
            // 兜底发 done{0/0,stop}」——无终止事件 = 传输截断，报错不发 done。
            for (const [, t] of toolAccum) {
              if (!t.name) continue
              let input: unknown
              try {
                input = t.args ? JSON.parse(t.args) : {}
              } catch {
                input = { _raw: t.args }
              }
              yield { type: 'tool', id: t.callId, name: t.name, input }
            }
            toolAccum.clear()
            // A-5（二十九轮）：多条加密推理项 → 流尾一次性汇总留痕丢弃条数
            //（GenResult.reasoningEncrypted 覆盖式只留末条，前 N-1 条不再无感消失）
            if (reasoningItemCount > 1) {
              log.warn('responses', `单回合收到 ${reasoningItemCount} 条加密推理项，GenResult 仅保留末条（丢弃 ${reasoningItemCount - 1} 条，chat 回传推理状态以末条为准）`)
            }
            if (terminal === 'none') {
              yield { type: 'error', message: '传输截断：流结束无终止事件', retryable: true, code: 'NETWORK' }
            }
            return
          } catch (e) {
            if (!consumedAny && isMidChain400(e, OpenAI.APIError, attempt, plan)) {
              lastErr = e
              continue // 建连期 400 → 尝试下一个降级参数面（流已开始消费则不重跑，见 consumedAny 注释）
            }
            throw e
          }
        }
        throw lastErr ?? new Error('openai-responses stream: 无可用参数面')
      } catch (e) {
        yield toErrorEvent(e)
      }
    },
  }
}


/** 归一化 baseUrl（方案 §4.5 P0）：只去尾部斜杠，不剥 /v1（openai SDK 不自拼 /v1）。 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

