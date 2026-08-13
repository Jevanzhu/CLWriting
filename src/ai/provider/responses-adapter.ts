/**
 * OpenAI Responses API 适配器——OpenAI 官方新线格式（gpt-5 系列专用）。
 *
 * 与 Chat Completions（openai-adapter.ts）并存：同一 SDK 客户端，
 * 按模型名分派（isOSeries → Responses，其余 → Chat Completions）。
 *
 * 线格式差异（与 chat.completions 的关键不同）：
 * - 请求：input 数组（系统指令 → developer 角色）而非 messages；
 *   输出上限用 max_output_tokens（不是 max_tokens）
 * - 结构化输出：text.format = { type: 'json_schema', ... }（等价 Chat 的 response_format）
 * - 流事件：response.output_text.delta（文本增量）、
 *   response.function_call_arguments.delta（args 增量）、
 *   response.output_item.done（item 完成）、response.completed（含 usage/status）
 * - 无 finish_reason/choices；截断看 status='incomplete' + incomplete_details
 * - 无 tool_choice 参数——工具调用由模型自行决定，只能靠 prompt 引导（契约层已兜底校验重试）
 */
import OpenAI from 'openai'
import type { ProviderConf, GenRequest, GenEvent, ModelProvider, ModelCaps, TokenUsage, ToolDef } from './types.js'
import { redactSecret } from './redact.js'

/** tool_use 往返：assistant function_call item → role:'tool' 输出（call_id 关联） */
function toolOutputItem(toolUseId: string, content: string): Record<string, unknown> {
  return { type: 'function_call_output', call_id: toolUseId, output: content }
}

/** GenRequest → /v1/responses 请求体 */
function toParams(conf: ProviderConf, req: GenRequest): Record<string, unknown> {
  const input: Record<string, unknown>[] = []
  // 系统指令 → developer 角色（OpenAI 新约定；角色 'system' 仍兼容但官方建议 developer）
  if (req.systemPrompt) {
    input.push({ role: 'developer', content: req.systemPrompt })
  }
  // user/assistant 消息：纯文本直传；tool_result 展开为 function_call_output 输出项
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      input.push({ role: m.role, content: m.content })
    } else {
      const textParts: string[] = []
      for (const b of m.content) {
        if (b.type === 'text') textParts.push(b.text)
        else if (b.type === 'tool_use') {
          input.push({
            type: 'function_call',
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input),
          })
        } else if (b.type === 'tool_result') {
          input.push(toolOutputItem(b.toolUseId, b.content))
        }
      }
      if (m.role === 'assistant') {
        // assistant 文本作为 assistant 消息 content（text 与 function_call 分开两条）
        if (textParts.length > 0) input.push({ role: 'assistant', content: textParts.join('') })
      } else if (textParts.length > 0) {
        input.push({ role: 'user', content: textParts.join('') })
      }
    }
  }

  const params: Record<string, unknown> = {
    model: conf.model ?? '',
    input,
    stream: true,
  }
  if (req.maxTokens) params['max_output_tokens'] = req.maxTokens

  if (req.tools?.length) {
    params['tools'] = req.tools.map(toResponsesTool)
  }
  // 结构化输出：input_schema 驱动 → json_schema 格式（Chat Completions 侧等价 response_format）
  if (req.structured?.schema) {
    params['text'] = {
      format: {
        type: 'json_schema',
        name: 'output',
        schema: req.structured.schema,
        strict: true,
      },
    }
  }
  // stop_sequences → 无对应参数（官方 Responses 不支持自定义 stop），忽略

  return params
}

function toResponsesTool(tool: ToolDef): Record<string, unknown> {
  return { type: 'function', name: tool.name, description: tool.description ?? '', parameters: tool.input_schema }
}

export function createOpenAIResponsesProvider(conf: ProviderConf, client?: OpenAI, modelCaps?: ModelCaps | null): ModelProvider {
  const c = client ?? new OpenAI({ apiKey: conf.apiKey, baseURL: normalizeBaseUrl(conf.baseUrl) })

  return {
    conf,
    modelCaps: modelCaps ?? null,

    async *stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> {
      let doneEmitted = false
      // 分块拼装中的 function call：item_id → { callId, name, args }
      const toolAccum = new Map<string, { callId: string; name: string; args: string }>()
      // 已完成的 function call（arguments 完整）——item done 时发 tool 事件
      const completed = new Map<string, { callId: string; name: string; args: string }>()
      const emitDone = (usage: TokenUsage, stopReason: string): GenEvent | null => {
        if (doneEmitted) return null
        doneEmitted = true
        return { type: 'done', usage, stopReason }
      }

      try {
        // 400 降级：text.format（结构化输出）仅部分模型/网关支持；create 在连接阶段抛异常（尚未 yield），可安全重试
        let stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
        try {
          stream = await c.responses.create(toParams(conf, req) as unknown as OpenAI.Responses.ResponseCreateParamsStreaming, { signal })
        } catch (e) {
          if (e instanceof OpenAI.APIError && e.status === 400 && req.structured) {
            stream = await c.responses.create(toParams(conf, { ...req, structured: undefined }) as unknown as OpenAI.Responses.ResponseCreateParamsStreaming, { signal })
          } else {
            throw e
          }
        }

        for await (const event of stream) {
          switch (event.type) {
            case 'response.output_text.delta': {
              if (event.delta) yield { type: 'text', delta: event.delta }
              break
            }
            case 'response.function_call_arguments.delta': {
              const acc = toolAccum.get(event.item_id) ?? { callId: '', name: '', args: '' }
              if (event.delta) acc.args += event.delta
              toolAccum.set(event.item_id, acc)
              break
            }
            case 'response.output_item.done': {
              const item = event.item
              if (item.type === 'function_call') {
                // 名称已随 item 完整给出；args 已增量拼完
                const itemId = item.id ?? item.call_id ?? ''
                const acc = toolAccum.get(itemId) ?? { callId: '', name: '', args: '' }
                acc.callId = item.call_id ?? itemId
                acc.name = item.name
                acc.args = acc.args || item.arguments || ''
                toolAccum.delete(itemId)
                completed.set(itemId, acc)
              }
              break
            }
            case 'response.completed': {
              const r = event.response
              // 完成事件自带 output_text（全部文本）+ usage；逐字增量已由 delta 事件产出，这里只发 done
              const stopReason =
                r.status === 'incomplete' && r.incomplete_details?.reason === 'max_output_tokens'
                  ? 'max_tokens'
                  : 'stop'
              const usage: TokenUsage = {
                inputTokens: r.usage?.input_tokens ?? 0,
                outputTokens: r.usage?.output_tokens ?? 0,
              }
              const ev = emitDone(usage, stopReason)
              if (ev) yield ev
              break
            }
            case 'response.incomplete': {
              // 截断：无 usage 由 stream 结束兜底发 done
              const r = event.response
              if (r.status === 'incomplete' && r.incomplete_details?.reason === 'max_output_tokens') {
                const ev = emitDone(
                  { inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 },
                  'max_tokens',
                )
                if (ev) yield ev
              }
              break
            }
          }
        }

        // 流结束：发未发出的 tool 事件（无 completed 事件兜底）+ done（无 completed 事件兜底）
        for (const [, t] of completed) {
          let input: unknown
          try {
            input = t.args ? JSON.parse(t.args) : {}
          } catch {
            input = { _raw: t.args }
          }
          yield { type: 'tool', id: t.callId, name: t.name, input }
        }
        completed.clear()
        if (!doneEmitted) {
          const ev = emitDone({ inputTokens: 0, outputTokens: 0 }, 'stop')
          if (ev) yield ev
        }
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

/** SDK 异常 → GenEvent.error（message 经 redactSecret 脱敏，§6.2 D9） */
function toErrorEvent(e: unknown): GenEvent {
  // P2-AI-4：APIUserAbortError extends APIError（status undefined），须前置判定
  //（P3-Q6 已在 openai/anthropic 适配器补齐，responses 遗漏——用户中断应报「已中断」而非 API undefined）
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
