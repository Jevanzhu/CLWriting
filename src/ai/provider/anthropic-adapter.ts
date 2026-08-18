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
import { persistDegraded, lookupDegraded, modelConfOf } from './store.js'
import { redactSecret } from './redact.js'
import { quirksFor } from './model-quirks.js'
import { anthropicClientOpts } from './models.js'
import { httpStatusToCode, headerErrorFields } from './failure.js'

/**
 * 创建 Anthropic 客户端——按 auth 策略发对应认证 header（官方与中转分开）。
 *
 * 之前无条件同时发 x-api-key + Bearer，严格网关看到多余认证头会 400。
 * auth 策略（types.ts）：
 * - anthropic   → 只发 x-api-key + anthropic-version（官方格式）
 * - claudeAuth  → 只发 Authorization: Bearer（Claude 中转 / 网关）
 * - bearer      → 同 claudeAuth（anthropic 协议下的 Bearer 中转）
 *
 * 构造参数统一走 models.anthropicClientOpts（CC-P1-1：env 污染双向阻断的单一
 * 真相源——claudeAuth/bearer 分支 apiKey:null 防止 SDK 回退读 env
 * ANTHROPIC_API_KEY 造成双认证头；此处原先的私有副本漏了该防线）。
 */
function createClient(conf: ProviderConf): Anthropic {
  const auth = conf.auth ?? 'anthropic'
  return new Anthropic(
    anthropicClientOpts(normalizeAnthropicBaseUrl(conf.baseUrl), conf.apiKey, auth),
  )
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
    // #5：max_tokens 用表值（如 claude 16384 / deepseek 384000），兜底 8192。
    // 阶段 14 §7.2 显式 resolve：调用方 cap（req.maxTokens）→ 模型行覆盖（用户声明）→ quirks 表 → 协议兜底。
    max_tokens: req.maxTokens ?? modelConfOf(conf)?.maxTokens ?? q.maxOutputTokens ?? MAX_TOKENS,
    messages: req.messages.map(toAnthropicMessage),
    stream: true,
    // #4：空 system 不发字段（对齐 OpenAI 侧守卫，严格中转 system:"" 可 400）
    ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
  }
  // tools
  if (req.tools?.length) {
    params['tools'] = req.tools.map(toAnthropicTool)
  }
  // tool_choice 按表 toolChoiceMode 翻译（V-P2-9，对齐 openai-adapter §6.1）：
  // named → any/tool/auto 原样（claude/glm/kimi）；
  // required（deepseek：官方仅 auto/none/required，anthropic 端点指名 type:'tool' 会 400）
  //   → 强制意图转 type:'any'（不指名），auto 原样；
  // auto → 仅 auto 发（不支持强制），none → 不发。
  // #12：disable_parallel_tool_use 仅 parallelControl 为真才发
  const dptu = q.parallelControl ? { disable_parallel_tool_use: true } : {}
  if (req.toolChoice && q.toolChoiceMode !== 'none') {
    if (q.toolChoiceMode === 'named') {
      if (req.toolChoice === 'any') {
        params['tool_choice'] = { type: 'any', ...dptu }
      } else if (req.toolChoice === 'tool' && req.toolName) {
        params['tool_choice'] = { type: 'tool', name: req.toolName, ...dptu }
      } else if (req.toolChoice === 'auto') {
        params['tool_choice'] = { type: 'auto', ...dptu }
      }
    } else if (q.toolChoiceMode === 'required') {
      if (req.toolChoice === 'any' || req.toolChoice === 'tool') {
        params['tool_choice'] = { type: 'any', ...dptu } // 指名意图降级为 any（deepseek 400 防线）
      } else if (req.toolChoice === 'auto') {
        params['tool_choice'] = { type: 'auto', ...dptu }
      }
    } else if (q.toolChoiceMode === 'auto') {
      if (req.toolChoice === 'auto') {
        params['tool_choice'] = { type: 'auto', ...dptu }
      }
      // 'any'/'tool' → 不支持，不发（prompt 引导 + 契约层校验重试兜底）
    }
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
      let cacheReadFromStart: number | undefined // D4：message_start 的 cache 读量（message_delta 缺字段时兜底）
      let cacheWriteFromStart: number | undefined // D4：message_start 的 cache 写量（同上）
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
        // 降级命中 → 写记忆（providers.json 复用原 modelCaps 槽），下次首发即剥。
        const degradedKey = conf.id && conf.model ? `${conf.id}/${conf.model}` : null
        // D2：优先 lookupDegraded 新鲜读（适配器实例缓存后，捕获 store 是创建时快照，
        // 会读到旧记忆）；未注册查通道（单测直连适配器）→ 回落捕获 store 快照
        const degraded = degradedKey
          ? (lookupDegraded(degradedKey) ?? (store?.modelCaps?.[degradedKey] ? true : undefined))
          : undefined
        const q = quirksFor(conf.model ?? '')
        // P3-5：400 降级链在「剥 structured」之外加末端「剥 tools → 纯文本」一环——
        // unknown 系列（识别不出时 toolUse 保守为 true）若实际不支持工具调用，
        // 纯 tools 请求 400 后不再同形状反复重试到放弃（此前无级可退）。
        // 剥 tools 成功不写 structured 记忆（归因不同，防污染记忆）。
        const stripStructured =
          req.structured && q.structuredMode !== 'none' ? ({ ...req, structured: undefined } as GenRequest) : null
        const stripTools = req.tools?.length
          ? ({ ...req, tools: undefined, toolChoice: undefined, toolName: undefined } as GenRequest)
          : null
        let attempts: GenRequest[]
        if (stripStructured && stripTools) {
          // 记忆命中 → 首发即用剥除版（否则记忆反而关闭降级链、structured 照发 → 必败）
          attempts = degraded ? [stripStructured, stripTools] : [req, stripStructured, stripTools]
        } else if (stripStructured) {
          attempts = degraded ? [stripStructured] : [req, stripStructured]
        } else if (stripTools) {
          attempts = [req, stripTools]
        } else {
          attempts = [req]
        }
        let stream: AsyncIterable<Anthropic.RawMessageStreamEvent> | null = null
        let lastErr: unknown = null
        for (const attempt of attempts) {
          try {
            stream = await c.messages.create(toParams(conf, attempt), { signal })
            // 仅当「剥 structured 的重试」建流成功才写记忆（防任意 400 误归因污染记忆）；
            // P3-5：剥 tools 的 attempt 不写 structured 记忆（归因不同）。
            // D2：落盘走 persistDegraded 通道（不依赖捕获 store），store 快照有则同步双写
            if (attempt !== req && attempt === stripStructured && degradedKey) {
              if (store) store.modelCaps[degradedKey] = { structured: false }
              persistDegraded(degradedKey)
            }
            break
          } catch (e) {
            // 非最后 attempt 的 400 → 尝试下一参数面；最后一个 400 透传原文（不被降级掩盖）
            if (e instanceof Anthropic.APIError && e.status === 400 && attempt !== attempts[attempts.length - 1]) {
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
              // input_tokens 在 message_start（message_delta 一般不含，P2-3）；
              // D4：cache 读/写量同点捕获（Anthropic input_tokens 不含 cache，独立记账）
              inputTokensFromStart = event.message.usage.input_tokens
              cacheReadFromStart = event.message.usage.cache_read_input_tokens ?? undefined
              cacheWriteFromStart = event.message.usage.cache_creation_input_tokens ?? undefined
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
                const cacheRead = event.usage.cache_read_input_tokens ?? cacheReadFromStart
                const cacheWrite = event.usage.cache_creation_input_tokens ?? cacheWriteFromStart
                const usage: TokenUsage = {
                  inputTokens: event.usage.input_tokens ?? inputTokensFromStart,
                  outputTokens: event.usage.output_tokens ?? 0,
                  ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
                  ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
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

/** SDK 异常 → GenEvent.error（message 经 redactSecret 脱敏，§6.2 D9；A5 附结构化 code） */
function toErrorEvent(e: unknown): GenEvent {
  // P3-Q6：APIUserAbortError extends APIError（status undefined），须在 APIError 分支前判定
  if (e instanceof Anthropic.APIUserAbortError) {
    return { type: 'error', message: '已中断', retryable: false, code: 'ABORTED' }
  }
  // A5：连接层失败（含 APIConnectionTimeoutError）单列——status undefined 的 APIError
  if (e instanceof Anthropic.APIConnectionError) {
    return { type: 'error', message: redactSecret(e.message), retryable: false, code: 'NETWORK' }
  }
  if (e instanceof Anthropic.APIError) {
    const retryable = e.status === 429 || (e.status ?? 0) >= 500
    return {
      type: 'error',
      message: redactSecret(`Anthropic API ${e.status}: ${e.message}`),
      retryable,
      code: httpStatusToCode(e.status, e.message),
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...headerErrorFields(e.headers),
      ...(e.requestID ? { requestId: e.requestID } : {}),
    }
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return { type: 'error', message: '已中断', retryable: false, code: 'ABORTED' }
  }
  const msg = e instanceof Error ? e.message : String(e)
  return { type: 'error', message: redactSecret(msg), retryable: false, code: 'PROTOCOL' }
}
