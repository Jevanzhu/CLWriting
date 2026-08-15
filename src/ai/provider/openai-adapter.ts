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
 * 400 降级链：structured（json_schema）→ effort，连接期异常未 yield 可安全重试。
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
import { persistDegraded } from './store.js'
import { redactSecret } from './redact.js'
import { quirksFor } from './model-quirks.js'

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
 * 线格式选择由 UI 的 Protocol 值决定（openai = Chat Completions，
 * openai-responses = Responses API），不再靠 model 名自动猜测。
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
  // 输出上限参数名（各家新旧名不同；缺省则不发，让模型用自己的默认值）
  if (req.maxTokens) {
    params[q.maxTokensKey] = req.maxTokens
  }

  if (req.tools?.length) {
    params['tools'] = req.tools.map(toOpenAITool)
  }

  // W-P2-10：强制工具调用（non-auto）且 parallelControl 支持 → 关并行工具（parallel_tool_calls:false）。
  // 与 anthropic 线 disable_parallel_tool_use:true 同语义（W0 意图：强制工具名时避免并行发散），
  // 对齐 quirks 表注释「parallel_tool_calls 可关」——此前 openai 线从不发，字段恒缺省（并行默认开）。
  // 注意：parallel_tool_calls 是顶层 chat.completions 参数，不是 tool_choice 的子字段。
  const forced = req.toolChoice && (req.toolChoice === 'any' || req.toolChoice === 'tool')
  if (forced && q.parallelControl) params['parallel_tool_calls'] = false
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

export function createOpenAIProviderChat(conf: ProviderConf, client?: OpenAI, store?: ProviderStore): ModelProvider {
  const c = client ?? createClient(conf)
  const q = quirksFor(conf.model ?? '')

  return {
    conf,

    async *stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> {
      let doneEmitted = false
      let pendingStopReason = 'stop' // finish_reason 先到但 usage 在后续 chunk → 延迟发 done
      const emitDone = (usage: TokenUsage, stopReason: string): GenEvent | null => {
        if (doneEmitted) return null
        doneEmitted = true
        return { type: 'done', usage, stopReason }
      }

      // 400 降级链（方案 §6.5）：表驱动后首发即正确，只留「中转怪癖」兜底——
      // json_schema/json_object 网关兼容性最参差 → 剥 structured 重试一级。
      // effort 不再入链（表已保证该发的才发）。连接期异常（未 yield）可安全重试。
      // 降级命中 → 写记忆（providers.json 复用原 modelCaps 槽），下次首发即剥。
      const degradedKey = conf.id && conf.model ? `${conf.id}/${conf.model}` : null
      const degraded = degradedKey ? store?.modelCaps?.[degradedKey] : undefined
      let attempts: GenRequest[] = [req]
      if (req.structured && q.structuredMode !== 'none') {
        const stripped = { ...req } as GenRequest
        delete (stripped as { structured?: unknown }).structured
        // 记忆命中 → 首发即用剥除版（否则记忆反而关闭降级链、structured 照发 → 必败）
        attempts = degraded ? [stripped] : [req, stripped]
      }

      try {
        let lastErr: unknown = null
        for (const attempt of attempts) {
          try {
            const stream = await c.chat.completions.create(
              toParams(conf, attempt) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
              { signal },
            )
            // 仅当「剥 structured 的重试」建流成功才写记忆（防任意 400 误归因污染记忆）
            if (attempt !== req && degradedKey && store) {
              store.modelCaps[degradedKey] = { structured: false }
              persistDegraded(degradedKey)
            }
            // 消费流（tool_calls 增量拼装 / text / reasoning / usage）
            const toolAccum = new Map<number, { id: string; name: string; argsBuf: string }>()
            for await (const chunk of stream) {
              const usage = chunk.usage
              // usage 双兜底：Kimi 文档自相矛盾（usage 可能在 choices[0]，§4.4）；
              // SDK 的 Choice 类型未含该字段（非官方），运行时由厂商端点下发
              const choiceUsage = (chunk.choices?.[0] as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | undefined)?.usage
              const effectiveUsage = usage ?? choiceUsage
              const choice = chunk.choices?.[0]
              if (!choice) {
                // usage-only chunk（最后一个 chunk 只含 usage）
                if (effectiveUsage) {
                  const ev = emitDone(
                    { inputTokens: effectiveUsage.prompt_tokens ?? 0, outputTokens: effectiveUsage.completion_tokens ?? 0 },
                    pendingStopReason,
                  )
                  if (ev) yield ev
                }
                continue
              }

              const delta = choice.delta

              // 文本增量（delta 可能为 null —— 非官方端点偶发，须可选链兜底防 TypeError 致 GEN_FAIL）
              if (delta?.content) {
                yield { type: 'text', delta: delta.content }
              }

              // 思维链增量（DeepSeek/Kimi 思考模型的 reasoning_content）→ reasoning 事件（方案 §4.2）
              // OpenAI SDK 的 Delta 类型未含该字段（非官方），运行时由厂商端点下发
              const reasoningDelta = (delta as { reasoning_content?: string } | null)?.reasoning_content
              if (reasoningDelta) {
                yield { type: 'reasoning', delta: reasoningDelta }
              }

              // tool_calls 增量
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index
                  let acc = toolAccum.get(idx)
                  if (!acc) {
                    acc = { id: tc.id ?? '', name: tc.function?.name ?? '', argsBuf: '' }
                    toolAccum.set(idx, acc)
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
                // finish_reason chunk 自带 usage（非 include_usage 模式）→ 直接 done
                if (effectiveUsage) {
                  const ev = emitDone(
                    { inputTokens: effectiveUsage.prompt_tokens ?? 0, outputTokens: effectiveUsage.completion_tokens ?? 0 },
                    pendingStopReason,
                  )
                  if (ev) yield ev
                }
                // 无 usage → 等 usage-only chunk；若不来由 stream 结束兜底
              }
            }
            // P2-AI-2：流异常截断无 finish_reason 时，补发 toolAccum 残留（与 responses-adapter 一致）
            if (!doneEmitted) {
              let fallbackIdx = 0
              for (const [, acc] of toolAccum) {
                if (!acc.name) continue
                let input: unknown
                try { input = acc.argsBuf ? JSON.parse(acc.argsBuf) : {} } catch { input = { _raw: acc.argsBuf } }
                yield { type: 'tool', id: acc.id || `call_${fallbackIdx}`, name: acc.name, input }
                fallbackIdx++
              }
              toolAccum.clear()
              const ev = emitDone({ inputTokens: 0, outputTokens: 0 }, pendingStopReason)
              if (ev) yield ev
            }
            return
          } catch (e) {
            // 非最后 attempt 的 400 → 尝试下一参数面；最后一个 400 透传原文（不被降级掩盖）
            if (e instanceof OpenAI.APIError && e.status === 400 && attempt !== attempts[attempts.length - 1]) {
              lastErr = e
              continue // 尝试下一个降级参数面
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

/** SDK 异常 → GenEvent.error（message 经 redactSecret 脱敏，§6.2 D9） */
function toErrorEvent(e: unknown): GenEvent {
  // P3-Q6：APIUserAbortError extends APIError（status undefined），须在 APIError 分支前判定，
  // 否则用户中断被误报「OpenAI API undefined: Request was aborted」
  if (e instanceof OpenAI.APIUserAbortError) {
    return { type: 'error', message: '已中断', retryable: false }
  }
  if (e instanceof OpenAI.APIError) {
    const retryable = e.status === 429 || (e.status ?? 0) >= 500
    return { type: 'error', message: redactSecret(`OpenAI API ${e.status}: ${e.message}`), retryable }
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return { type: 'error', message: '已中断', retryable: false }
  }
  const msg = e instanceof Error ? e.message : String(e)
  return { type: 'error', message: redactSecret(msg), retryable: false }
}
