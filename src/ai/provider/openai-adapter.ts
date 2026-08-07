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
  ModelCaps,
  TokenUsage,
  ToolDef,
  ChatMsg,
  ContentBlock,
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
  return /^o\d/.test(model)
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
  // assistant 消息：text + tool_calls
  if (m.role === 'assistant') {
    const msg: Record<string, unknown> = { role: 'assistant', content: textParts.join('') || null }
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
  // system prompt 作为 developer 消息（OpenAI 新约定）
  if (req.systemPrompt) {
    messages.push({ role: 'system', content: req.systemPrompt })
  }
  for (const m of req.messages) {
    messages.push(...toOpenAIMessages(m))
  }

  const params: Record<string, unknown> = {
    model: conf.model,
    messages,
    stream: true,
  }
  // max_tokens 可选——缺省则不发，让模型用自己的默认值
  if (req.maxTokens) {
    params[isOSeries(conf.model ?? '') ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens
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
    // P1-4：OpenAI 官方 reasoning_effort 仅接受 low|medium|high，xhigh 降级为 high
    params['reasoning_effort'] = req.effort === 'xhigh' ? 'high' : req.effort
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

export function createOpenAIProvider(conf: ProviderConf, client?: OpenAI, modelCaps?: ModelCaps | null): ModelProvider {
  const c = client ?? createClient(conf)

  return {
    conf,
    modelCaps: modelCaps ?? null,

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

          // 文本增量（delta 可能为 null —— 非官方端点偶发，须可选链兜底防 TypeError 致 GEN_FAIL）
          if (delta?.content) {
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
                yield { type: 'tool', id: acc.id, name: acc.name, input }
              }
            }
            toolAccum.clear()

            // 统一 stopReason 命名：OpenAI 'length' → 'max_tokens'（与 Anthropic 对齐，generateText 截断检查靠此）
            pendingStopReason =
              choice.finish_reason === 'tool_calls' ? 'tool_use'
              : choice.finish_reason === 'length' ? 'max_tokens'
              : choice.finish_reason
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
