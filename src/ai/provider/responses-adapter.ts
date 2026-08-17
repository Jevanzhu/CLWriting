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
import { persistDegraded, lookupDegraded } from './store.js'
import { redactSecret } from './redact.js'
import { responsesQuirksFor } from './model-quirks.js'
import { httpStatusToCode, headerErrorFields } from './failure.js'

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
        input.push(toolOutputItem(b.toolUseId, b.content))
      }
    }
    if (m.role === 'assistant') {
      input.push(...reasoningItems)
      if (textParts.length > 0) input.push({ role: 'assistant', content: textParts.join('') })
      input.push(...toolUseItems)
    } else {
      if (textParts.length > 0) input.push({ role: 'user', content: textParts.join('') })
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
  if (req.maxTokens) params['max_output_tokens'] = req.maxTokens

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

/** Responses usage 线格式 → TokenUsage（R3 缺口 12：细节计量） */
function toUsage(u: OpenAI.Responses.ResponseUsage | null | undefined): TokenUsage {
  const cached = u?.input_tokens_details?.cached_tokens
  const reasoning = u?.output_tokens_details?.reasoning_tokens
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  }
}

export function createOpenAIResponsesProvider(
  conf: ProviderConf,
  client?: OpenAI,
  store?: ProviderStore,
): ModelProvider {
  const c = client ?? new OpenAI({ apiKey: conf.apiKey, baseURL: normalizeBaseUrl(conf.baseUrl) })
  const q = responsesQuirksFor(conf.model ?? '')

  return {
    conf,

    async *stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> {
      let doneEmitted = false
      const emitDone = (usage: TokenUsage, stopReason: string): GenEvent | null => {
        if (doneEmitted) return null
        doneEmitted = true
        return { type: 'done', usage, stopReason }
      }

      // 400 降级链（缺口 14，照 openai-adapter 当前实现）：structured → tools 两级剥除；
      // 降级命中写记忆（providers.json modelCaps 槽），下次首发即剥。
      const degradedKey = conf.id && conf.model ? `${conf.id}/${conf.model}` : null
      // D2：优先 lookupDegraded 新鲜读（适配器实例缓存后，捕获 store 是创建时快照）；
      // 未注册查通道（单测直连适配器）→ 回落捕获 store 快照
      const degraded = degradedKey
        ? (lookupDegraded(degradedKey) ?? (store?.modelCaps?.[degradedKey] ? true : undefined))
        : undefined
      const stripStructured =
        req.structured && q.structuredMode !== 'none' ? ({ ...req, structured: undefined } as GenRequest) : null
      const stripTools = req.tools?.length
        ? ({ ...req, tools: undefined, toolChoice: undefined, toolName: undefined } as GenRequest)
        : null
      let attempts: GenRequest[]
      if (stripStructured && stripTools) {
        attempts = degraded ? [stripStructured, stripTools] : [req, stripStructured, stripTools]
      } else if (stripStructured) {
        attempts = degraded ? [stripStructured] : [req, stripStructured]
      } else if (stripTools) {
        attempts = [req, stripTools]
      } else {
        attempts = [req]
      }

      try {
        let lastErr: unknown = null
        for (const attempt of attempts) {
          try {
            const stream = await c.responses.create(
              toParams(conf, attempt) as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
              { signal },
            )
            // 仅当「剥 structured 的重试」建流成功才写记忆（防任意 400 误归因）；
            // 剥 tools 的 attempt 不写 structured 记忆（归因不同，防污染）
            if (attempt !== req && attempt === stripStructured && degradedKey) {
              if (store) store.modelCaps[degradedKey] = { structured: false }
              persistDegraded(degradedKey)
            }

            // 分块拼装中的 function call：item_id → { callId, name, args }
            // （P2 复审：声明在 attempt 循环内每次新建——mid-stream 400 降级续跑时，
            // 上一 attempt 的半截拼装不得泄入下一 attempt（对齐 openai-adapter 结构））
            const toolAccum = new Map<string, { callId: string; name: string; args: string }>()

            // ── R1 事件循环：终止事件契约 ──
            // 流必须以 completed / incomplete / failed 之一收尾；无终止事件 = 传输截断。
            // 网关偏差挂点（缺口 18）：响应侧缺字段时在此入口加 per-family normalize。
            let terminal: 'completed' | 'incomplete' | 'failed' | 'none' = 'none'
            let toolYielded = false
            for await (const event of stream) {
              switch (event.type) {
                case 'response.output_text.delta': {
                  if (event.delta) yield { type: 'text', delta: event.delta }
                  break
                }
                // 缺口 4：reasoning 增量——reasoning_text.delta（OpenAI/grok 原生文本）
                // 与 reasoning_summary_text.delta（OpenAI summary）都归一到 reasoning 事件
                case 'response.reasoning_text.delta':
                case 'response.reasoning_summary_text.delta': {
                  if (event.delta) yield { type: 'reasoning', delta: event.delta }
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
                    // P1-S5：done 之前直接 yield tool（probe break-on-done 语义）
                    const itemId = item.id ?? item.call_id ?? ''
                    const acc = toolAccum.get(itemId) ?? { callId: '', name: '', args: '' }
                    acc.callId = item.call_id ?? itemId
                    acc.name = item.name
                    acc.args = acc.args || item.arguments || ''
                    toolAccum.delete(itemId)
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
                  const hasOutput =
                    toolYielded || Boolean(r.output?.some((it) => it.type === 'message' || it.type === 'function_call'))
                  if (!hasOutput) {
                    yield { type: 'error', message: '模型返回空产出（Responses completed 无内容项）', retryable: false }
                    return
                  }
                  const ev = emitDone(toUsage(r.usage), toolYielded ? 'tool_use' : 'stop')
                  if (ev) yield ev
                  break
                }
                case 'response.incomplete': {
                  terminal = 'incomplete'
                  const r = event.response
                  const reason = r.incomplete_details?.reason
                  if (reason === 'max_output_tokens') {
                    const ev = emitDone(toUsage(r.usage), 'max_tokens')
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
                  // R1（缺口 1）：failed → error 不发 done（此前落穿被流结束兜底伪装成
                  // done{stop, 0/0}）；message 脱敏后带上
                  const msg = event.response.error?.message ?? `response.failed (status=${event.response.status ?? 'unknown'})`
                  yield { type: 'error', message: redactSecret(msg), retryable: false }
                  return
                }
                case 'error': {
                  // SDK 流中错误事件（网关 mid-stream error）——同 failed 处理
                  terminal = 'failed'
                  yield { type: 'error', message: redactSecret(event.message ?? '流中错误事件'), retryable: false }
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
            if (terminal === 'none') {
              yield { type: 'error', message: '传输截断：流结束无终止事件', retryable: true, code: 'NETWORK' }
            }
            return
          } catch (e) {
            // 非最后 attempt 的 400 → 尝试下一参数面；最后一个 400 透传原文
            if (e instanceof OpenAI.APIError && e.status === 400 && attempt !== attempts[attempts.length - 1]) {
              lastErr = e
              continue
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

/** SDK 异常 → GenEvent.error（message 经 redactSecret 脱敏；A5 附结构化 code） */
function toErrorEvent(e: unknown): GenEvent {
  // P2-AI-4：APIUserAbortError extends APIError（status undefined），须前置判定
  if (e instanceof OpenAI.APIUserAbortError) {
    return { type: 'error', message: '已中断', retryable: false, code: 'ABORTED' }
  }
  // A5：连接层失败（含 APIConnectionTimeoutError）单列——status undefined 的 APIError
  if (e instanceof OpenAI.APIConnectionError) {
    return { type: 'error', message: redactSecret(e.message), retryable: false, code: 'NETWORK' }
  }
  if (e instanceof OpenAI.APIError) {
    const retryable = e.status === 429 || (e.status ?? 0) >= 500
    return {
      type: 'error',
      message: redactSecret(`OpenAI API ${e.status}: ${e.message}`),
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
