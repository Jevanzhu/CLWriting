/**
 * OpenAI 协议适配器（方案 §四①）。
 *
 * 使用 openai 包，baseURL 接用户填的端点。覆盖厂商原生端点、中继、自建。
 *
 * tool_use 翻译：GenRequest.tools → function calling；
 * tool_choice 'any' → 'required', 'tool' → {type:'function',function:{name}}。
 * effort → reasoning_effort。
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
} from './types.js'
import { redactSecret } from './redact.js'

/** 创建 OpenAI 客户端 */
function createClient(conf: ProviderConf): OpenAI {
  return new OpenAI({
    apiKey: conf.apiKey,
    baseURL: conf.baseUrl,
  })
}

/** 判断模型名是否为 o 系列（用 max_completion_tokens 而非 max_tokens） */
function isOSeries(model: string): boolean {
  return /^o\d/.test(model) || model.startsWith('o3') || model.startsWith('o4')
}

/** GenRequest → OpenAI ChatCompletionCreateParamsStreaming */
function toParams(conf: ProviderConf, req: GenRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  // system prompt 作为 developer 消息（OpenAI 新约定）
  if (req.systemPrompt) {
    messages.push({ role: 'system', content: req.systemPrompt })
  }
  for (const m of req.messages) {
    messages.push({ role: m.role, content: m.content })
  }

  const params: Record<string, unknown> = {
    model: conf.model,
    messages,
    stream: true,
    // o 系列用 max_completion_tokens
    ...(isOSeries(conf.model) ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
  }

  if (req.tools?.length) {
    params['tools'] = req.tools.map(toOpenAITool)
  }

  if (req.toolChoice === 'any') {
    params['tool_choice'] = 'required'
  } else if (req.toolChoice === 'tool' && req.toolName) {
    params['tool_choice'] = { type: 'function', function: { name: req.toolName } }
  } else if (req.toolChoice === 'auto') {
    params['tool_choice'] = 'auto'
  }

  if (req.effort) {
    params['reasoning_effort'] = req.effort
  }

  if (req.stopSequences?.length) {
    params['stop'] = req.stopSequences
  }

  // 流式 usage（OpenAI 需显式开启）
  params['stream_options'] = { include_usage: true }

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

export function createOpenAIProvider(conf: ProviderConf, client?: OpenAI): ModelProvider {
  const c = client ?? createClient(conf)

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

      // tool_calls 增量拼装：按 index 聚合 arguments JSON 片段
      const toolAccum = new Map<number, { id: string; name: string; argsBuf: string }>()

      try {
        const stream = await c.chat.completions.create(toParams(conf, req) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, { signal })

        for await (const chunk of stream) {
          const usage = chunk.usage
          const choice = chunk.choices?.[0]
          if (!choice) {
            // usage-only chunk（最后一个 chunk 只含 usage）
            if (usage) {
              const ev = emitDone(
                { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 },
                pendingStopReason,
              )
              if (ev) yield ev
            }
            continue
          }

          const delta = choice.delta

          // 文本增量
          if (delta.content) {
            yield { type: 'text', delta: delta.content }
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
            for (const [, acc] of toolAccum) {
              if (acc.name && acc.argsBuf) {
                let input: unknown
                try {
                  input = JSON.parse(acc.argsBuf)
                } catch {
                  input = { _raw: acc.argsBuf }
                }
                yield { type: 'tool', name: acc.name, input }
              }
            }
            toolAccum.clear()

            pendingStopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason
            // finish_reason chunk 自带 usage（非 include_usage 模式）→ 直接 done
            if (usage) {
              const ev = emitDone(
                { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 },
                pendingStopReason,
              )
              if (ev) yield ev
            }
            // 无 usage → 等 usage-only chunk；若不来由 stream 结束兜底
          }
        }

        if (!doneEmitted) {
          const ev = emitDone({ inputTokens: 0, outputTokens: 0 }, pendingStopReason)
          if (ev) yield ev
        }
      } catch (e) {
        yield toErrorEvent(e)
      }
    },
  }
}

/** SDK 异常 → GenEvent.error（message 经 redactSecret 脱敏，§6.2 D9） */
function toErrorEvent(e: unknown): GenEvent {
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
