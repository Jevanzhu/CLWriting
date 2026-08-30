/**
 * OpenAI 协议适配器（方案 §四①）。
 *
 * 使用 openai 包，baseURL 接用户填的端点。覆盖厂商原生端点、中继、自建。
 *
 * tool_use 翻译：GenRequest.tools → function calling；
 * tool_choice 'any' → 'required', 'tool' → {type:'function',function:{name}}。
 * effort → reasoning_effort。
 * 思维链：delta.reasoning_content → reasoning 事件；assistant 消息的 reasoning 块
 * 写回 reasoning_content（DeepSeek/Kimi 多轮带 tools 硬要求，方案 §4.2）。
 *
 * 参数翻译全部由 model-quirks 表驱动（方案 §4.1/§4.4，删除 isOSeries 启发式）：
 * effort 发射 / max_tokens 参数名 / stop 裁剪 / stream_options / 结构化档位。
 * 400 降级链：structured（json_schema）→ effort，连接期异常未 yield 可安全重试
 * （公共实现与约定见 adapter-errors.ts）。
 *
 * 流式 tool_calls 按索引增量拼装 arguments 字符串，末尾整体解析。
 */
import OpenAI from 'openai'
import type {
  ProviderConf,
  GenRequest,
  GenEvent,
  ModelProvider,
  TokenUsage,
  ToolDef,
  ChatMsg,
  ContentBlock,
} from './types.js'
import type { ProviderStore } from './store.js'
import { modelConfOf } from './store.js'
import { quirksFor } from './model-quirks.js'
import { makeToErrorEvent, buildDegradeAttempts, isMidChain400, markStructuredDegrade } from './adapter-errors.js'
import { estimateInputTokens, estimateOutputTokens } from './usage-estimate.js'

/** SDK 异常 → GenEvent.error：公共工厂实现（adapter-errors），此处只贴本线错误类与 label */
const toErrorEvent = makeToErrorEvent({
  APIError: OpenAI.APIError,
  APIUserAbortError: OpenAI.APIUserAbortError,
  APIConnectionError: OpenAI.APIConnectionError,
  label: 'OpenAI API',
})

/** 创建 OpenAI 客户端（baseUrl 归一化，防 /v1 重复） */
function createClient(conf: ProviderConf): OpenAI {
  return new OpenAI({
    apiKey: conf.apiKey,
    baseURL: normalizeOpenAIBaseUrl(conf.baseUrl),
  })
}

/**
 * 归一化 baseUrl（方案 §4.5 P0）：只去尾部斜杠，**不剥 /v1**。
 * openai SDK 不自拼 /v1，基址须自带版本路径（官方 https://api.openai.com/v1）；
 * 剥了官方端点 404。anthropic 侧 SDK 自拼 /v1，行为不同（见 anthropic 适配器）。
 */
function normalizeOpenAIBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * OpenAI Chat Completions 适配器（/v1/chat/completions）。
 *
 * 线格式由 UI 的 Protocol 值决定（openai = Chat Completions），不再靠 model 名自动猜测。
 * （openai-responses 协议线由 responses-adapter.ts 独立承载，经 registry 路由——2026-08-17 启用批回接。）
 * 参数差异由 model-quirks 表驱动（方案 §4.1）。
 */
export function createOpenAIProvider(conf: ProviderConf, client?: OpenAI): ModelProvider {
  return createOpenAIProviderChat(conf, client)
}

/**
 * ChatMsg → OpenAI 线格式 message 列表（纯文本直传；block 数组展开）。
 *
 * OpenAI 与 Anthropic 的 tool 往返形状根本不同：
 * - assistant 的 tool_use → tool_calls 数组（arguments 须 JSON.stringify）
 * - user 的 tool_result → **独立** role:'tool' 消息（每个 tool_call 一条）
 * - 同一条 user 含 N 个 tool_result → 展开 N 条 role:'tool'
 */
function toOpenAIMessages(m: ChatMsg): Record<string, unknown>[] {
  if (typeof m.content === 'string') return [{ role: m.role, content: m.content }]

  // block 数组：分离 text/tool_use(tool_calls) 和 tool_result
  const textParts: string[] = []
  const toolCalls: Record<string, unknown>[] = []
  const toolResults: Record<string, unknown>[] = []

  for (const b of m.content as ContentBlock[]) {
    if (b.type === 'text') {
      textParts.push(b.text)
    } else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      })
    } else if (b.type === 'tool_result') {
      toolResults.push({
        role: 'tool',
        tool_call_id: b.toolUseId,
        content: b.content,
      })
    }
  }

  const out: Record<string, unknown>[] = []
  // assistant 消息：text + reasoning_content + tool_calls
  if (m.role === 'assistant') {
    const msg: Record<string, unknown> = { role: 'assistant', content: textParts.join('') || null }
    // 思维链往返（DeepSeek/Kimi 思考模型硬要求，见方案 §4.2）——reasoning 块写回 reasoning_content
    const reasoning = (m.content as ContentBlock[]).filter((b) => b.type === 'reasoning').map((b) => b.text).join('')
    if (reasoning) msg['reasoning_content'] = reasoning
    if (toolCalls.length > 0) msg['tool_calls'] = toolCalls
    out.push(msg)
  } else {
    // user 消息：纯 text 部分作为 user content；tool_result 展开为独立 role:'tool' 消息
    if (textParts.length > 0) out.push({ role: 'user', content: textParts.join('') })
    out.push(...toolResults)
  }
  return out
}

/** GenRequest → OpenAI ChatCompletionCreateParamsStreaming */
function toParams(conf: ProviderConf, req: GenRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  // P3-Q7：实发 role:'system'（OpenAI 官方兼容别名；developer 角色为更激进约定，暂不采用）
  if (req.systemPrompt) {
    messages.push({ role: 'system', content: req.systemPrompt })
  }
  for (const m of req.messages) {
    messages.push(...toOpenAIMessages(m))
  }

  // 参数翻译由 quirks 表驱动（方案 §4.1）——检测不出系列则保守省略可选参数
  const q = quirksFor(conf.model ?? '')

  const params: Record<string, unknown> = {
    // B-P2-6：conf.model 可能为 null/undefined（未选模型时），兜底空串防 SDK 报参数错
    model: conf.model ?? '',
    messages,
    stream: true,
  }
  // 输出上限参数名（各家新旧名不同；缺省则不发，让模型用自己的默认值）。
  // 阶段 14 §7.2：调用方显式 cap（req.maxTokens）优先；其次用户模型行覆盖（modelConfOf）；
  // 仍无 → 不发（OpenAI 线维持旧行为——quirks 表值不自动补发，防改变请求形状）。
  const tokenCap = req.maxTokens ?? modelConfOf(conf)?.maxTokens
  if (tokenCap) {
    params[q.maxTokensKey] = tokenCap
  }

  if (req.tools?.length) {
    params['tools'] = req.tools.map(toOpenAITool)
  }

  // W-P2-10：toolChoice 存在（含 'auto'）且 parallelControl 支持 → 关并行工具（parallel_tool_calls:false）。
  // RB-AI-P2-4：对齐 anthropic 线（toolChoice 存在即发 disable_parallel_tool_use）——契约 W0
  // 「一轮最多一个工具调用」此前 openai 线仅 forced 才关并行，chat 的 toolChoice='auto' 恒不关。
  // 注意：parallel_tool_calls 是顶层 chat.completions 参数，不是 tool_choice 的子字段。
  if (req.toolChoice && q.parallelControl) params['parallel_tool_calls'] = false
  // tool_choice 按表 toolChoiceMode 翻译（表驱动重构 §6.1）：
  // named → 指名/required/auto 原样；
  // required（Kimi k3：指名与思考不兼容）→ 强制意图转 required，不指名；
  // auto（GLM：仅 auto 可用）→ 非 auto 意图不发 tool_choice（prompt 引导兜底）；
  // none（responses 协议不在此）→ 不发
  if (req.toolChoice && q.toolChoiceMode !== 'none') {
    if (q.toolChoiceMode === 'named') {
      if (req.toolChoice === 'any') {
        params['tool_choice'] = 'required'
      } else if (req.toolChoice === 'tool' && req.toolName) {
        params['tool_choice'] = { type: 'function', function: { name: req.toolName } }
      } else if (req.toolChoice === 'auto') {
        params['tool_choice'] = 'auto'
      }
    } else if (q.toolChoiceMode === 'required') {
      if (req.toolChoice === 'any' || req.toolChoice === 'tool') {
        params['tool_choice'] = 'required'
      } else if (req.toolChoice === 'auto') {
        params['tool_choice'] = 'auto'
      }
    } else if (q.toolChoiceMode === 'auto') {
      if (req.toolChoice === 'auto') {
        params['tool_choice'] = 'auto'
      }
      // 'any'/'tool' → 不支持，不发（prompt 引导 + 契约层校验重试兜底）
    }
  }

  // effort → reasoning_effort（各家档位与支持模型不同，由 quirks 收敛）
  if (req.effort) {
    const effort = q.reasoningEffort(req.effort)
    if (effort) {
      params['reasoning_effort'] = effort
      // DeepSeek：thinking 对象与 reasoning_effort 两种写法官方并存（方案 §4.1）
      if (q.thinkingWithEffort) params['thinking'] = { type: 'enabled' }
    }
  }

  // stop 裁剪（各家上限不同；grok 推理模型不发）
  if (req.stopSequences?.length) {
    const stops = q.trimStop(req.stopSequences)
    if (stops?.length) params['stop'] = stops
  }

  // 结构化输出档位（json_schema 400 由降级链剥除；json_object 需 prompt 约束）
  if (req.structured?.schema && q.structuredMode !== 'none') {
    params['response_format'] =
      q.structuredMode === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: 'output', schema: req.structured.schema, strict: true } }
        : { type: 'json_object' }
  }

  // 流式 usage（各家支持不同；GLM 无此参数，usage 末 chunk 自带）
  if (q.emitStreamOptions) {
    params['stream_options'] = { include_usage: true }
  }

  return params
}

function toOpenAITool(tool: ToolDef): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema,
    },
  }
}

/** OpenAI 兼容线 usage 形态（prompt_tokens_details 非所有中转都发，可选） */
interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

/**
 * usage 线格式 → TokenUsage（D4：prompt_tokens_details.cached_tokens → cacheReadTokens）。
 * M-1：prompt_tokens **已含** cache 命中部分，边界处扣减归一成「inputTokens 不含 cache 读」
 * 的统一口径（Anthropic 语义），下游计价/预算四档分计公式对两协议同时成立；
 * 中转缺 prompt_tokens_details 时 cached=undefined，行为与旧口径一致。
 */
function toUsage(u: WireUsage | undefined | null): TokenUsage {
  const cached = u?.prompt_tokens_details?.cached_tokens
  return {
    inputTokens: Math.max(0, (u?.prompt_tokens ?? 0) - (cached ?? 0)),
    outputTokens: u?.completion_tokens ?? 0,
    ...(cached ? { cacheReadTokens: cached } : {}),
  }
}

export function createOpenAIProviderChat(conf: ProviderConf, client?: OpenAI, store?: ProviderStore): ModelProvider {
  const c = client ?? createClient(conf)
  const q = quirksFor(conf.model ?? '')

  return {
    conf,

    async *stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> {
      let doneEmitted = false
      let degraded = false // Z-12：成功建流是否用了降级参数面（emitDone 闭包读）
      let pendingStopReason = 'stop' // finish_reason 先到但 usage 在后续 chunk → 延迟发 done
      let sawFinishReason = false // 流结束兜底区分：见过=完成但网关不发 usage；没见过=传输截断
      // Q-13（第十五轮）：resolve 后终值随 done 透出（降级链 attempt 不改 maxTokens；
      // openai 线无兜底不发 → undefined，与 toParams 上线值同源）
      const resolvedMaxTokens = req.maxTokens ?? modelConfOf(conf)?.maxTokens
      const emitDone = (usage: TokenUsage, stopReason: string): GenEvent | null => {
        if (doneEmitted) return null
        doneEmitted = true
        return { type: 'done', usage, stopReason, resolvedMaxTokens, ...(degraded ? { degraded: true } : {}) }
      }

      // 400 降级链（方案 §6.5）：attempts 构造 / 400 续跑闸 / 记忆写入走 adapter-errors
      // 公共实现——「连接期异常（未 yield）可安全重试、流中异常不重跑」的约定见其注释。
      const plan = buildDegradeAttempts(req, q.structuredMode, conf, store)

      try {
        let lastErr: unknown = null
        for (const attempt of plan.attempts) {
          // ii-1：本 attempt 是否已开始消费流。降级续跑只对「建连期 400」安全——
          // 已收到 chunk 后换参数面重跑会让消费者收到重复增量，一律转终态错误。
          let consumedAny = false
          try {
            const stream = await c.chat.completions.create(
              toParams(conf, attempt) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
              { signal },
            )
            markStructuredDegrade(plan, attempt, store)
            // Z-12（第五十八轮）：成功建流用的是非首发（降级）参数面 → done 事件带 degraded
            // A3（五十九轮）：判据并入降级记忆命中——基准改 plan.original（记忆命中时
            // attempts[0] 已是剥除版，旧判据对首发恒 false，记忆命中路径漏标 degraded）
            degraded = attempt !== plan.original
            // 消费流（tool_calls 增量拼装 / text / reasoning / usage）
            const toolAccum = new Map<number | string, { id: string; name: string; argsBuf: string }>()
            // R73-1：产出累计（文本/思维链 delta 串联 + tool 参数 JSON 串）——网关吞 usage
            // 时按此折算估计用量（usage-estimate.ts 同源系数），不再按 0/0 入账
            const outText: string[] = []
            const outToolText: string[] = []
            // R26-3：最后可见 usage（逐 chunk 覆盖）——done 延后到流末统一 emit（见循环后注）
            let latestUsage: WireUsage | null = null
            // R65-9（总六十五轮）：网关缺省 tc.index 的兜底聚合——此前并入同一 undefined
            // 键会把多个 tool_call 拼成一团；改「带 id/name 的新调用分片 → 自增兜底键、
            // 续片归并最近兜底键」，无 index 流也能拆出独立调用（有 index 走原路径不变）
            let idxlessSeq = 0
            let lastIdxlessKey: string | null = null
            for await (const chunk of stream) {
              consumedAny = true
              const usage = chunk.usage
              // usage 双兜底：Kimi 文档自相矛盾（usage 可能在 choices[0]，§4.4）；
              // SDK 的 Choice 类型未含该字段（非官方），运行时由厂商端点下发
              const choiceUsage = (chunk.choices?.[0] as { usage?: WireUsage } | undefined)?.usage
              const effectiveUsage = usage ?? choiceUsage
              const choice = chunk.choices?.[0]
              if (!choice) {
                // usage-only chunk（最后一个 chunk 只含 usage）
                // R26-3：不再此处即席 emit——usage 记入 latestUsage，流末统一取最新值 emit
                if (effectiveUsage) latestUsage = effectiveUsage
                continue
              }

              const delta = choice.delta

              // 文本增量（delta 可能为 null —— 非官方端点偶发，须可选链兜底防 TypeError 致 GEN_FAIL）
              if (delta?.content) {
                outText.push(delta.content) // R73-1：产出累计
                yield { type: 'text', delta: delta.content }
              }

              // 思维链增量（DeepSeek/Kimi 思考模型的 reasoning_content）→ reasoning 事件（方案 §4.2）
              // OpenAI SDK 的 Delta 类型未含该字段（非官方），运行时由厂商端点下发
              const reasoningDelta = (delta as { reasoning_content?: string } | null)?.reasoning_content
              if (reasoningDelta) {
                outText.push(reasoningDelta) // R73-1：产出累计（推理 token 也是真实计费面）
                yield { type: 'reasoning', delta: reasoningDelta }
              }

              // tool_calls 增量
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  // R65-9：key 决策——有 index 原样；缺 index 时新调用分片（带 id/name）
                  // 开新兜底键，续片归并最近兜底键（上一兜底键已被 finish_reason 清空则另开）
                  let key: number | string
                  if (tc.index !== undefined) {
                    key = tc.index
                  } else {
                    const startsCall = (tc.id !== undefined && tc.id !== '') || !!tc.function?.name
                    if (startsCall || lastIdxlessKey === null || !toolAccum.has(lastIdxlessKey)) {
                      lastIdxlessKey = `no-index-${++idxlessSeq}`
                    }
                    key = lastIdxlessKey
                  }
                  let acc = toolAccum.get(key)
                  if (!acc) {
                    acc = { id: tc.id ?? '', name: tc.function?.name ?? '', argsBuf: '' }
                    toolAccum.set(key, acc)
                  }
                  if (tc.function?.name) acc.name = tc.function.name
                  if (tc.function?.arguments) acc.argsBuf += tc.function.arguments
                }
              }

              // finish_reason → 发 tool 事件；done 延迟到 usage-only chunk（include_usage 模式）
              if (choice.finish_reason) {
                // 所有 tool_calls 已拼完 → 发出
                let toolIdx = 0
                for (const [, acc] of toolAccum) {
                  // P1-AI-1：有 name 即发出工具调用；空 args 合法（无参工具如 check_chapter）
                  if (acc.name) {
                    let input: unknown
                    if (acc.argsBuf) {
                      try {
                        input = JSON.parse(acc.argsBuf)
                      } catch {
                        input = { _raw: acc.argsBuf }
                      }
                    } else {
                      input = {}
                    }
                    outToolText.push(acc.name + acc.argsBuf) // R73-1：tool 参数也是真实计费面
                    // P3-Q5：非官方兼容端点不发 id 时以空串入历史会被拒绝 → 生成 call_ 兜底 id
                    const id = acc.id || `call_${toolIdx}`
                    yield { type: 'tool', id, name: acc.name, input }
                    toolIdx++
                  }
                }
                toolAccum.clear()

                // 统一 stopReason 命名：OpenAI 'length' → 'max_tokens'（与 Anthropic 对齐，generateText 截断检查靠此）
                pendingStopReason =
                  choice.finish_reason === 'tool_calls' ? 'tool_use'
                  : choice.finish_reason === 'length' ? 'max_tokens'
                  : choice.finish_reason
                sawFinishReason = true
                // finish_reason chunk 自带 usage（非 include_usage 模式）→ 记入 latestUsage
                //（R26-3：done 延后到流末统一 emit，见循环后注）
                if (effectiveUsage) latestUsage = effectiveUsage
                // 无 usage → 等 usage-only chunk；若不来由 stream 结束兜底
              }
            }
            // R26-3（二十六轮）：done 统一延后到流末尾，取最后可见 usage——原「首见即定」
            // 口径（emitDone 幂等门锁首个 usage）：逐 chunk 回 usage 的网关（本适配器明确
            // 要兜的怪形态）会被记成早期部分值，末 chunk 完整 usage 被丢弃，记账系统性
            // 低估。R27-2（二十七轮）：Anthropic 线已改为同款「末见 wins」（此前该线
            // message_delta 即席 emitDone 锁首值，与本处旧描述正相反），两线口径归一。
            if (latestUsage) {
              const ev = emitDone(toUsage(latestUsage), pendingStopReason)
              if (ev) yield ev
            }
            // P2-AI-2：流异常收尾（usage 已在上面统一 emit 过则整块跳过）
            if (!doneEmitted) {
              if (sawFinishReason) {
                // R26-25（二十六轮）：残留 tool 事件只在「正常完成但缺 usage」分支补发并
                // 计入产出估计——原口径传输截断分支也先 flush tool 再发 error，gen 层遇
                // error 必弃事件，序列自相矛盾（纯语义噪音），且截断 tool 参数抬高 output
                // 估计（该分支本来就不入账，更无意义）。
                let fallbackIdx = 0
                for (const [, acc] of toolAccum) {
                  if (!acc.name) continue
                  let input: unknown
                  try { input = acc.argsBuf ? JSON.parse(acc.argsBuf) : {} } catch { input = { _raw: acc.argsBuf } }
                  outToolText.push(acc.name + acc.argsBuf) // R73-1：残留 tool 参数计入产出累计
                  yield { type: 'tool', id: acc.id || `call_${fallbackIdx}`, name: acc.name, input }
                  fallbackIdx++
                }
                toolAccum.clear()
                // 网关完成了生成但不回 usage（include_usage 不兼容面）——放行生成不判错重试
                //（判错重试对这类网关是全量破坏）。R73-1（二十一轮 A-1）：不再按 0/0 入账
                //（预算闸 tokens/cost 对该类端点永不生效、成本报表系统性偏低）——按可得信号
                // 估计入账：output ≈ 累计 delta 文本/tool 参数字符折算（usage-estimate.ts
                // 与备料 estimateTokens 同源系数），input ≈ 本次请求 prompt 字符折算；
                // estimated 标记估计口径，runner 记账/self-heal 消费面照常按数值生效。
                const estimatedUsage: TokenUsage = {
                  inputTokens: estimateInputTokens(req, conf.model ?? undefined),
                  outputTokens: estimateOutputTokens(outText.join('') + outToolText.join(''), conf.model ?? undefined),
                  estimated: true,
                }
                const ev = emitDone(estimatedUsage, pendingStopReason)
                if (ev) yield ev
              } else {
                // R1 对齐（Responses 线同款）：无终止事件的流结束 = 传输截断，报错不发
                // done——真实计费调用不得按成功 0 成本入账
                yield { type: 'error', message: '传输截断：流结束无终止事件', retryable: true, code: 'NETWORK' }
              }
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
        throw lastErr ?? new Error('openai stream: 无可用参数面')
      } catch (e) {
        yield toErrorEvent(e)
      }
    },
  }
}

