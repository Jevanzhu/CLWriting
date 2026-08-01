/**
 * Anthropic 协议适配器（方案 §四①）。
 *
 * 使用 @anthropic-ai/sdk，baseURL 与凭据全部来自用户配置的 ProviderConf。
 * auth 决定发 x-api-key（官方）还是 Bearer（中转，authToken）。
 *
 * effort 翻译为 output_config.effort；thinking 不发（走模型默认 adaptive）。
 * tool_use 是契约层核心——content_block_delta 的 InputJSONDelta 增量拼装。
 */
import Anthropic from '@anthropic-ai/sdk'
import type {
  ProviderConf,
  GenRequest,
  GenEvent,
  ModelProvider,
  TokenUsage,
  ToolDef,
} from './types.js'

/** 创建 Anthropic 客户端（auth 策略分流） */
function createClient(conf: ProviderConf): Anthropic {
  const opts: Record<string, unknown> = { baseURL: conf.baseUrl }
  if (conf.auth === 'claudeAuth') {
    // 中转服务：只认 Bearer（authToken 而非 apiKey）
    opts['authToken'] = conf.apiKey
  } else {
    // 官方：x-api-key
    opts['apiKey'] = conf.apiKey
  }
  return new Anthropic(opts)
}

/** GenRequest → Anthropic MessageCreateParams */
function toParams(conf: ProviderConf, req: GenRequest): Anthropic.MessageCreateParamsStreaming {
  const params: Anthropic.MessageCreateParamsStreaming = {
    model: conf.model,
    max_tokens: req.maxTokens,
    system: req.systemPrompt,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  }
  // tools
  if (req.tools?.length) {
    params['tools'] = req.tools.map(toAnthropicTool)
  }
  // tool_choice
  if (req.toolChoice === 'any') {
    params['tool_choice'] = { type: 'any', disable_parallel_tool_use: true }
  } else if (req.toolChoice === 'tool' && req.toolName) {
    params['tool_choice'] = { type: 'tool', name: req.toolName, disable_parallel_tool_use: true }
  } else if (req.toolChoice === 'auto') {
    params['tool_choice'] = { type: 'auto' }
  }
  // effort → output_config.effort
  if (req.effort) {
    params['output_config'] = { effort: req.effort }
  }
  // stop sequences
  if (req.stopSequences?.length) {
    params['stop_sequences'] = req.stopSequences
  }
  return params
}

function toAnthropicTool(tool: ToolDef): Anthropic.Tool {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
  }
}

export function createAnthropicProvider(conf: ProviderConf): ModelProvider {
  const client = createClient(conf)

  return {
    conf,

    async *stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> {
      let doneEmitted = false
      // 去重：某些上游发重复 message_delta（cc-switch issue 记录的故障）
      // done 幂等，重复到达时忽略
      const emitDone = (usage: TokenUsage, stopReason: string): GenEvent | null => {
        if (doneEmitted) return null
        doneEmitted = true
        return { type: 'done', usage, stopReason }
      }

      try {
        const stream = await client.messages.create(toParams(conf, req), { signal })

        // tool_use input 增量拼装：content_block_start 记 tool name，
        // input_json_delta 增量拼 JSON 字符串，content_block_stop 时整体解析
        const toolBlocks = new Map<number, { name: string; jsonBuf: string }>()

        for await (const event of stream) {
          switch (event.type) {
            case 'content_block_start': {
              const block = event.content_block
              if (block.type === 'tool_use') {
                toolBlocks.set(event.index, { name: block.name, jsonBuf: '' })
              }
              break
            }
            case 'content_block_delta': {
              const delta = event.delta
              if (delta.type === 'text_delta') {
                yield { type: 'text', delta: delta.text }
              } else if (delta.type === 'input_json_delta') {
                const tb = toolBlocks.get(event.index)
                if (tb) tb.jsonBuf += delta.partial_json
              }
              break
            }
            case 'content_block_stop': {
              const tb = toolBlocks.get(event.index)
              if (tb) {
                let input: unknown
                try {
                  input = tb.jsonBuf ? JSON.parse(tb.jsonBuf) : {}
                } catch {
                  input = { _raw: tb.jsonBuf }
                }
                yield { type: 'tool', name: tb.name, input }
              }
              break
            }
            case 'message_delta': {
              // 最终 usage + stop_reason 在 message_delta 里
              if (event.usage) {
                const usage: TokenUsage = {
                  inputTokens: event.usage.input_tokens ?? 0,
                  outputTokens: event.usage.output_tokens ?? 0,
                }
                const ev = emitDone(usage, event.delta?.stop_reason ?? 'end_turn')
                if (ev) yield ev
              }
              break
            }
          }
        }

        // 兜底：某些端点可能不推 message_delta usage → 用 message_start 的 usage
        if (!doneEmitted) {
          const ev = emitDone({ inputTokens: 0, outputTokens: 0 }, 'end_turn')
          if (ev) yield ev
        }
      } catch (e) {
        yield toErrorEvent(e)
      }
    },
  }
}

/** SDK 异常 → GenEvent.error */
function toErrorEvent(e: unknown): GenEvent {
  if (e instanceof Anthropic.APIError) {
    const retryable = e.status === 429 || (e.status ?? 0) >= 500
    return { type: 'error', message: `Anthropic API ${e.status}: ${e.message}`, retryable }
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return { type: 'error', message: '已中断', retryable: false }
  }
  const msg = e instanceof Error ? e.message : String(e)
  return { type: 'error', message: msg, retryable: false }
}
