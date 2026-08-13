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
  ChatMsg,
  ContentBlock as ClwContentBlock,
} from './types.js'
import type { ProviderStore } from './store.js'
import { redactSecret } from './redact.js'
import { quirksFor } from './model-quirks.js'

/**
 * 创建 Anthropic 客户端——按 auth 策略发对应认证 header（官方与中转分开）。
 *
 * 之前无条件同时发 x-api-key + Bearer，严格网关看到多余认证头会 400。
 * auth 策略（types.ts）：
 * - anthropic   → 只发 x-api-key + anthropic-version（官方格式）
 * - claudeAuth  → 只发 Authorization: Bearer（Claude 中转 / 网关）
 * - bearer      → 同 claudeAuth（anthropic 协议下的 Bearer 中转）
 */
function createClient(conf: ProviderConf): Anthropic {
  const auth = conf.auth ?? 'anthropic'
  const base: ConstructorParameters<typeof Anthropic>[0] = {
    baseURL: normalizeAnthropicBaseUrl(conf.baseUrl),
    // 显式 authToken:null 阻断环境变量 ANTHROPIC_AUTH_TOKEN 注入（SDK 只在
    // authToken === undefined 时读 env）——本机 Claude Code 凭据会污染成双认证头，
    // 严格网关可能 400/返回匿名数据（模型列表只 2 个即此因）
    authToken: null,
  }
  if (auth === 'anthropic') {
    base.apiKey = conf.apiKey
    base.defaultHeaders = { 'anthropic-version': '2023-06-01' }
  } else {
    // claudeAuth / bearer：用 SDK 原生 authToken 只发 Authorization: Bearer，不发 x-api-key
    base.authToken = conf.apiKey
    base.defaultHeaders = { 'anthropic-version': '2023-06-01' }
  }
  return new Anthropic(base)
}

/**
 * baseUrl 归一化——存的是「用户直觉地址」，请求时按 SDK 拼接习惯去重。
 * Anthropic SDK 固定请求 {baseURL}/v1/messages：
 * - https://api.anthropic.com        → 原样（SDK 拼 /v1/messages）
 * - https://api.anthropic.com/v1     → 去掉尾部 v1，防 /v1/v1/messages
 * - https://gw.example.com/xxx/v1    → 去掉尾部 v1
 */
function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** Anthropic API 强制要求 max_tokens（不可省略）——兜底取安全值（P1-5：128000 对旧模型 400） */
const MAX_TOKENS = 8192

/** ChatMsg → Anthropic 线格式 message（纯文本直传；block 数组逐项映射） */
function toAnthropicMessage(m: ChatMsg): Anthropic.MessageParam {
  if (typeof m.content === 'string') return { role: m.role, content: m.content }
  // block 数组 → Anthropic content block
  const blocks: Anthropic.ContentBlockParam[] = m.content.flatMap((b: ClwContentBlock): Anthropic.ContentBlockParam[] => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }]
    // reasoning 块（chat 侧 DeepSeek/Kimi 回传产物）→ 原生端点无此字段，静默丢弃（方案 §4.2）
    if (b.type === 'reasoning') return []
    if (b.type === 'tool_use') return [{ type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> }]
    // tool_result: Anthropic 要求挂在 user 消息里，toolUseId → tool_use_id
    return [{ type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) }]
  })
  return { role: m.role, content: blocks }
}

/** GenRequest → Anthropic MessageCreateParams */
function toParams(conf: ProviderConf, req: GenRequest): Anthropic.MessageCreateParamsStreaming {
  // 表驱动参数翻译（表驱动重构 §6.1）
  const q = quirksFor(conf.model ?? '')

  const params: Anthropic.MessageCreateParamsStreaming = {
    model: conf.model ?? '',
    // #5：max_tokens 用表值（如 claude 16384 / deepseek 384000），兜底 8192
    max_tokens: req.maxTokens ?? q.maxOutputTokens ?? MAX_TOKENS,
    messages: req.messages.map(toAnthropicMessage),
    stream: true,
    // #4：空 system 不发字段（对齐 OpenAI 侧守卫，严格中转 system:"" 可 400）
    ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
  }
  // tools
  if (req.tools?.length) {
    params['tools'] = req.tools.map(toAnthropicTool)
  }
  // tool_choice（#12：disable_parallel_tool_use 仅 parallelControl 为真才发）
  const dptu = q.parallelControl ? { disable_parallel_tool_use: true } : {}
  if (req.toolChoice === 'any') {
    params['tool_choice'] = { type: 'any', ...dptu }
  } else if (req.toolChoice === 'tool' && req.toolName) {
    params['tool_choice'] = { type: 'tool', name: req.toolName, ...dptu }
  } else if (req.toolChoice === 'auto') {
    params['tool_choice'] = { type: 'auto', ...dptu }
  }
  // #2：effort 仅当表 anthropicEffortWire=output_config 才发（claude/deepseek），
  // 其余厂家的 anthropic 端点文档缺失 → 保守不发。档位收敛用 effortMap。
  if (req.effort && q.anthropicEffortWire === 'output_config') {
    const mapped = q.effortMap?.[req.effort] ?? req.effort
    params['output_config'] = { effort: mapped }
  }
  // structured → output_config.format，按表 structuredMode 翻译（表驱动重构 §6.1）：
  // json_schema → format.json_schema；json_object → format.json_object（deepseek 只认这个）；
  // none → 不发（模型不支持，prompt 引导兜底）。硬编码 json_schema 会让 deepseek/glm
  // 的 anthropic 端点 400（格式有问题），且降级链剥掉 structured 后丢失结构化输出。
  if (req.structured?.schema && q.structuredMode !== 'none') {
    // SDK 的 JSONOutputFormat 要求 json_object 也带 schema，但 deepseek 网关要求不带——
    // 用 Record 断言绕开 SDK 过严类型，保持实际线格式正确
    const format: Record<string, unknown> =
      q.structuredMode === 'json_schema'
        ? { type: 'json_schema', schema: req.structured.schema }
        : { type: 'json_object' }
    params['output_config'] = {
      ...(params['output_config'] as Record<string, unknown> | undefined),
      format,
    } as unknown as Anthropic.OutputConfig
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

export function createAnthropicProvider(conf: ProviderConf, client?: Anthropic, store?: ProviderStore): ModelProvider {
  const c = client ?? createClient(conf)

  return {
    conf,

    async *stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> {
      let doneEmitted = false
      let inputTokensFromStart = 0 // message_start 带 input_tokens；message_delta 一般只有 output_tokens（P2-3）
      let pendingStopReason: string | null = null // N6：缓存 stop_reason，防与 usage 耦合丢失
      // 去重：某些上游发重复 message_delta（cc-switch issue 记录的故障）
      // done 幂等，重复到达时忽略
      const emitDone = (usage: TokenUsage, stopReason: string): GenEvent | null => {
        if (doneEmitted) return null
        doneEmitted = true
        return { type: 'done', usage, stopReason }
      }

      try {
        // 400 降级链（方案 §6.5）：表驱动后首发即正确，只留「中转怪癖」兜底——
        // output_config.format（json_schema）→ 剥 structured 重试一级。
        // effort 不再入链（表已保证该发的才发）。连接期异常（未 yield）可安全重试。
        // 降级命中 → 写记忆（providers.json 复用原 modelCaps 槽），下次直接跳过 structured。
        const degradedKey = conf.id && conf.model ? `${conf.id}/${conf.model}` : null
        const degraded = degradedKey ? store?.modelCaps?.[degradedKey] : undefined
        let attempts: GenRequest[] = [req]
        if (req.structured && !degraded) {
          const c = { ...req } as GenRequest
          delete (c as { structured?: unknown }).structured
          attempts.push(c)
        }
        let stream: AsyncIterable<Anthropic.RawMessageStreamEvent> | null = null
        let lastErr: unknown = null
        for (const attempt of attempts) {
          try {
            stream = await c.messages.create(toParams(conf, attempt), { signal })
            break
          } catch (e) {
            if (e instanceof Anthropic.APIError && e.status === 400 && attempts.length > 1) {
              // §6.5：降级命中 → 写记忆（structured 不支持）
              if (degradedKey && store) store.modelCaps[degradedKey] = { structured: false }
              lastErr = e
              continue
            }
            throw e
          }
        }
        if (!stream) throw lastErr

        // tool_use input 增量拼装：content_block_start 记 tool name，
        // input_json_delta 增量拼 JSON 字符串，content_block_stop 时整体解析
        const toolBlocks = new Map<number, { id: string; name: string; jsonBuf: string }>()

        for await (const event of stream) {
          switch (event.type) {
            case 'message_start': {
              // input_tokens 在 message_start（message_delta 一般不含，P2-3）
              inputTokensFromStart = event.message.usage.input_tokens
              break
            }
            case 'content_block_start': {
              const block = event.content_block
              if (block.type === 'tool_use') {
                toolBlocks.set(event.index, { id: block.id ?? '', name: block.name, jsonBuf: '' })
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
                yield { type: 'tool', id: tb.id, name: tb.name, input }
              }
              break
            }
            case 'message_delta': {
              // 缓存 stop_reason（即使无 usage 也不丢）——N6
              if (event.delta?.stop_reason) pendingStopReason = event.delta.stop_reason
              // 最终 usage + stop_reason 在 message_delta 里（input_tokens 合并 message_start 缓存，P2-3）
              if (event.usage) {
                const usage: TokenUsage = {
                  inputTokens: event.usage.input_tokens ?? inputTokensFromStart,
                  outputTokens: event.usage.output_tokens ?? 0,
                }
                const ev = emitDone(usage, pendingStopReason ?? 'end_turn')
                if (ev) yield ev
              }
              break;
            }
          }
        }

        // 兜底：某些端点可能不推 message_delta usage → 用 message_start 缓存的 input_tokens
        if (!doneEmitted) {
          const ev = emitDone({ inputTokens: inputTokensFromStart, outputTokens: 0 }, pendingStopReason ?? 'end_turn')
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
  // P3-Q6：APIUserAbortError extends APIError（status undefined），须在 APIError 分支前判定
  if (e instanceof Anthropic.APIUserAbortError) {
    return { type: 'error', message: '已中断', retryable: false }
  }
  if (e instanceof Anthropic.APIError) {
    const retryable = e.status === 429 || (e.status ?? 0) >= 500
    return { type: 'error', message: redactSecret(`Anthropic API ${e.status}: ${e.message}`), retryable }
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return { type: 'error', message: '已中断', retryable: false }
  }
  const msg = e instanceof Error ? e.message : String(e)
  return { type: 'error', message: redactSecret(msg), retryable: false }
}
