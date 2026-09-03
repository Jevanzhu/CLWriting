/**
 * Anthropic 协议适配器（方案 §四①）。
 *
 * 使用 @anthropic-ai/sdk，baseURL 与凭据全部来自用户配置的 ProviderConf。
 * auth 决定发 x-api-key（官方）还是 Bearer（中转，authToken）。
 *
 * effort 翻译为 output_config.effort；thinking 不发（走模型默认 adaptive）。
 * R36-2（三十六轮）：claude 原生 + effort 组合显式禁思考（thinking:{type:'disabled'}）——
 * 扩展思考块若产出，多轮工具链要求回传带签名块（Anthropic 硬要求，零回传 400）。
 * 流侧对 thinking/signature/redacted_thinking 全弃是历史缺口：现在 thinking 文本以
 * reasoning 事件透出（三线口径对齐 openai/responses），块（含签名）在流内缓存；
 * 完整回传（带签名块进 ChatMsg）受类型扩展击穿 usage-estimate 所限留待跨批
 *（见 toParams 禁思考注 / toAnthropicMessage 注）。
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
import { modelConfOf } from './store.js'
import { quirksFor, detectFamily } from './model-quirks.js'
import { anthropicClientOpts } from './models.js'
import { makeToErrorEvent, buildDegradeAttempts, isMidChain400, markStructuredDegrade } from './adapter-errors.js'
import { estimateInputTokens, estimateOutputTokens } from './usage-estimate.js'

/** SDK 异常 → GenEvent.error：公共工厂实现（adapter-errors），此处只贴本线错误类与 label */
const toErrorEvent = makeToErrorEvent({
  APIError: Anthropic.APIError,
  APIUserAbortError: Anthropic.APIUserAbortError,
  APIConnectionError: Anthropic.APIConnectionError,
  label: 'Anthropic API',
})

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

/** Anthropic API 强制要求 max_tokens（不可省略）——兜底取安全值。
 *  R73-3（二十一轮 A-3）：8192 → 16384（对齐 quirks 表 claude 档 maxOutputTokens）——
 *  unknown 家族模型走协议兜底时长章必截断，且 MAX_TOKENS 是终态不可重试；16384 为
 *  现役 claude 安全下限（对旧模型 128000 才 400，16384 无此问题）。 */
const MAX_TOKENS = 16_384

/** ChatMsg → Anthropic 线格式 message（纯文本直传；block 数组逐项映射）。
 *  R30-10（三十轮）：映射后 content 为空数组（block 全为 reasoning 的消息）→ 返回 null，
 *  由 toParams 从请求历史剔除（见 toParams 处注）。 */
function toAnthropicMessage(m: ChatMsg): Anthropic.MessageParam | null {
  if (typeof m.content === 'string') return { role: m.role, content: m.content }
  // block 数组 → Anthropic content block
  const blocks: Anthropic.ContentBlockParam[] = m.content.flatMap((b: ClwContentBlock): Anthropic.ContentBlockParam[] => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }]
    // reasoning 块（chat 侧 DeepSeek/Kimi 回传产物）→ 原生端点无此字段，静默丢弃（方案 §4.2）。
    // R72-12（二十轮 A-11）记档：正确性依赖上游 sanitizeHistory 先剥离——若未来上游
    // 防线移除，此处丢弃即最后一道（仅丢回传推理文本，不损对话内容，风险可接受）
    if (b.type === 'reasoning') return []
    // R36-2（三十六轮）注：Anthropic 扩展思考块的完整回传（带签名 thinking 块）需要
    // 在 ContentBlock 增加 thinking/redacted_thinking 变体 + gen/turns 侧签名载道——
    // 类型扩展会击穿 usage-estimate.flattenMsgContent 的 exhaust 分支（该文件不在本轮
    // 可修清单），故回传侧零透传维持；防 400 由 toParams 的 claude+effort 显式禁思考
    //（主防线）+ 上一条 reasoning 块丢弃（次防线）承担，完整回传留待跨批接通。
    if (b.type === 'tool_use') return [{ type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> }]
    // tool_result: Anthropic 要求挂在 user 消息里，toolUseId → tool_use_id
    return [{ type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) }]
  })
  // R30-10（三十轮）：全 reasoning 消息 flatMap 产出空数组 → null（toParams 过滤剔除）
  if (blocks.length === 0) return null
  return { role: m.role, content: blocks }
}

/** Q-13（第十五轮）：输出上限 resolve 单源——toParams 上线值与 done 事件透出值同源，
 *  防两处各写一份漂移（anthropic 线全链兜底：调用方 cap → 模型行 → quirks 表 → 8192） */
function resolveMaxTokens(conf: ProviderConf, req: GenRequest): number {
  return req.maxTokens ?? modelConfOf(conf)?.maxTokens ?? quirksFor(conf.model ?? '').maxOutputTokens ?? MAX_TOKENS
}

/** GenRequest → Anthropic MessageCreateParams */
function toParams(conf: ProviderConf, req: GenRequest): Anthropic.MessageCreateParamsStreaming {
  // 表驱动参数翻译（表驱动重构 §6.1）
  const q = quirksFor(conf.model ?? '')

  const params: Anthropic.MessageCreateParamsStreaming = {
    model: conf.model ?? '',
    // #5：max_tokens 用表值（如 claude 16384 / deepseek 384000），兜底 16384（= MAX_TOKENS，
    // R73-3 上调；R30-12（三十轮）：注释与常量同步，原「兜底 8192」为漂移残留）。
    // 阶段 14 §7.2 显式 resolve：调用方 cap（req.maxTokens）→ 模型行覆盖（用户声明）→ quirks 表 → 协议兜底。
    max_tokens: resolveMaxTokens(conf, req),
    // R30-10（三十轮）：仅 reasoning block 的 assistant 轮 flatMap 产出 content:[]，
    // Anthropic API 对空 content 数组 400——上游 sanitizeHistory 剥离是常规防线但非保证
    //（本适配器是最后防线）：无可渲染内容的轮次整条从请求历史剔除（text/tool_use/
    // tool_result 任一存在即保留；剔除后同 role 相邻消息由 Anthropic 端点合并为一轮）。
    messages: req.messages.map(toAnthropicMessage).filter((m): m is Anthropic.MessageParam => m !== null),
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
    // R36-2（三十六轮，保守路径）：
    // claude 原生 + effort 组合下模型默认 adaptive 思考会产出 thinking 块；而扩展思考
    // 多轮工具链要求回传带签名 thinking 块（Anthropic 硬要求），当前事件链路
    // （GenResult → chat 历史 → ChatMsg）尚无签名载道（gen/turns 批次外），零回传会
    // 400 触发 buildDegradeAttempts 剥工具重发（每轮翻倍请求 + 静默失去工具能力）。
    // 显式 thinking:{type:'disabled'} → 模型不产出思考块 → 无签名回传义务，多轮工具链
    // 不再 400。取舍：claude 在 effort 档下失去思考（体验影响经 reasoning 事件口径
    // 与 openai 线对齐的回退面收窄）；仅限 claude 家族——deepseek 的 anthropic 端点
    // 同为 output_config wire，但无 thinking 参数语义，禁发防未知 400。待 gen/turns
    // 批接通签名回传后此禁可收窄或移除（真机验证登记：400 实际频率待验证）。
    if (detectFamily(conf.model ?? '') === 'claude') {
      params['thinking'] = { type: 'disabled' }
    }
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
  // stop sequences——R33-19（三十三轮）：对齐 openai 线 q.trimStop（各家上限不同、
  // grok 推理模型不发；原全量透传在 anthropic 线缺同款防线，两线不对称）。
  if (req.stopSequences?.length) {
    const stops = q.trimStop(req.stopSequences)
    if (stops?.length) params['stop_sequences'] = stops
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

export function createAnthropicProvider(conf: ProviderConf, client?: Anthropic, store?: ProviderStore, userDataPath?: string): ModelProvider {
  const c = client ?? createClient(conf)

  return {
    conf,

    async *stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> {
      let doneEmitted = false
      let inputTokensFromStart = 0 // message_start 带 input_tokens；message_delta 一般只有 output_tokens（P2-3）
      let cacheReadFromStart: number | undefined // D4：message_start 的 cache 读量（message_delta 缺字段时兜底）
      let cacheWriteFromStart: number | undefined // D4：message_start 的 cache 写量（同上）
      let latestUsage: TokenUsage | null = null // R27-2：流内逐 delta 覆盖，流末统一 emit（末见 wins）
      let pendingStopReason: string | null = null // N6：缓存 stop_reason，防与 usage 耦合丢失
      let degraded = false // Z-12：成功建流是否用了降级参数面（emitDone 闭包读）
      // Q-13（第十五轮）：resolve 后终值随 done 透出（降级链 attempt 不改 maxTokens，
      // 按原始 req 计算与各 attempt toParams 上线值一致）
      const resolvedMaxTokens = resolveMaxTokens(conf, req)
      // 去重：某些上游发重复 message_delta（cc-switch issue 记录的故障）
      // done 幂等，重复到达时忽略
      const emitDone = (usage: TokenUsage, stopReason: string): GenEvent | null => {
        if (doneEmitted) return null
        doneEmitted = true
        return { type: 'done', usage, stopReason, resolvedMaxTokens, ...(degraded ? { degraded: true } : {}) }
      }

      try {
        // 400 降级链（方案 §6.5）：attempts 构造 / 400 续跑闸 / 记忆写入走 adapter-errors
        // 公共实现——「连接期异常（未 yield）可安全重试、流中异常不重跑」的约定见其注释。
        // R30-4（三十轮）：携来源 userDataPath——降级记忆读/写按显式 path 分发
        const q = quirksFor(conf.model ?? '')
        const plan = buildDegradeAttempts(req, q.structuredMode, conf, store, userDataPath)
        let stream: AsyncIterable<Anthropic.RawMessageStreamEvent> | null = null
        let lastErr: unknown = null
        for (const attempt of plan.attempts) {
          try {
            stream = await c.messages.create(toParams(conf, attempt), { signal })
            markStructuredDegrade(plan, attempt, store)
            // Z-12（第五十八轮）：成功建流用的是非首发（降级）参数面 → done 事件带
            // degraded（重放按事件重建会再 400 的口径缺口闭合）
            // A3（五十九轮）：判据并入降级记忆命中——基准改 plan.original（记忆命中时
            // attempts[0] 已是剥除版，旧判据对首发恒 false，记忆命中路径漏标 degraded）
            degraded = attempt !== plan.original
            break
          } catch (e) {
            if (isMidChain400(e, Anthropic.APIError, attempt, plan)) {
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
        // R36-2（三十六轮）：扩展思考块流内缓存——此前 thinking/signature/redacted_thinking
        // 全弃（思考文本无感 + 多轮工具链回传缺签名）。思考文本即时以 reasoning 事件透出
        // （三线口径对齐 openai reasoning_content / responses reasoning_text）；块整体（含
        // 签名）暂存流内——完整回传依赖上游把块带进 ChatMsg（见 toAnthropicMessage 注，
        // gen/turns 批次外）。redacted_thinking 的 data 在 content_block_start 整体下发。
        const thinkingBlocks = new Map<number, { thinking: string; signature: string } | { redacted: string }>()
        // R73-1：产出累计（text_delta 串联 + tool jsonBuf）——网关吞 usage 时按此折算
        // 估计用量（usage-estimate.ts 同源系数），不再按 0 输出入账
        const outText: string[] = []
        const outToolText: string[] = []

        for await (const event of stream) {
          switch (event.type) {
            case 'message_start': {
              // input_tokens 在 message_start（message_delta 一般不含，P2-3）；
              // D4：cache 读/写量同点捕获（Anthropic input_tokens 不含 cache，独立记账）
              // R26-2（二十六轮）：?? 0 终兜底——非标网关 message_start 缺 input_tokens 时
              // 原样赋 undefined 会覆盖声明侧的 0 初值，下游 TokenUsage.inputTokens 变
              // undefined → calls 记账 += 得 NaN → checkAiCallBudget 对 NaN 恒 false，
              // 该进程内 token/成本预算闸静默失效（cache/output 侧均有 ?? 兜底，唯此处漏）
              inputTokensFromStart = event.message.usage.input_tokens ?? 0
              cacheReadFromStart = event.message.usage.cache_read_input_tokens ?? undefined
              cacheWriteFromStart = event.message.usage.cache_creation_input_tokens ?? undefined
              break
            }
            case 'content_block_start': {
              const block = event.content_block
              if (block.type === 'tool_use') {
                // 低级项（第六轮）：非官方兼容端点可能不发 id——空 id 进历史会被
                // tool_result 关联拒绝，按块 index 生成兜底（对齐 OpenAI 线 P3-Q5）
                toolBlocks.set(event.index, { id: block.id || `toolu_${event.index}`, name: block.name, jsonBuf: '' })
              } else if (block.type === 'thinking') {
                // R36-2：思考块开（text 由 thinking_delta 增量下发）
                thinkingBlocks.set(event.index, { thinking: '', signature: '' })
              } else if (block.type === 'redacted_thinking') {
                // R36-2：密文块 data 在 start 事件整体下发（SDK 无 redacted_thinking_delta）
                thinkingBlocks.set(event.index, { redacted: block.data })
              }
              break
            }
            case 'content_block_delta': {
              const delta = event.delta
              if (delta.type === 'text_delta') {
                outText.push(delta.text) // R73-1：产出累计
                yield { type: 'text', delta: delta.text }
              } else if (delta.type === 'input_json_delta') {
                const tb = toolBlocks.get(event.index)
                if (tb) tb.jsonBuf += delta.partial_json
              } else if (delta.type === 'thinking_delta') {
                // R36-2：思考增量即刻以 reasoning 事件透出（对齐 openai 线
                // reasoning_content / responses 线 reasoning_text 口径）；文本入产出
                // 累计（思考 token 也是真实计费面，R73-1 估计入账与 Anthropic
                // output_tokens 含思考 token 的口径一致）
                const tb = thinkingBlocks.get(event.index)
                if (tb && 'thinking' in tb) tb.thinking += delta.thinking
                outText.push(delta.thinking)
                yield { type: 'reasoning', delta: delta.thinking }
              } else if (delta.type === 'signature_delta') {
                // R36-2：签名在 thinking 块末尾单独 delta 下发——附到对应块供回传侧
                // 使用（Anthropic「思考+工具必须回传带签名块」的签名来源）
                const tb = thinkingBlocks.get(event.index)
                if (tb && 'thinking' in tb) tb.signature = delta.signature
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
              // 最终 usage + stop_reason 在 message_delta 里（input_tokens 合并 message_start 缓存，P2-3）。
              // R27-2（二十七轮）：「末见 wins」——此前 message_delta 即席 emitDone（幂等门锁
              // 首个 usage），逐 delta 回 usage 的网关被记成早期部分值、末 delta 完整值被丢，
              // 与 openai 线 R26-3 末见口径分叉；现只记 latestUsage，流末统一 emit（下同）
              // R38-8（三十八轮）：空 usage 对象（{} truthy 但无计量字段）等价「无 usage」
              // ——原样进 merge 会把 latestUsage 置成 input=message_start 兜底、output=0
              // 的假计量，流末 done 走实测分支绕过估计兜底。对齐 openai 线 isRealUsage
              // （R36-14）口径：至少一个计量字段在位才采信，{} 落到流末估计分支（R73-1）。
              if (event.usage && (event.usage.input_tokens !== undefined || event.usage.output_tokens !== undefined)) {
                const cacheRead = event.usage.cache_read_input_tokens ?? cacheReadFromStart
                const cacheWrite = event.usage.cache_creation_input_tokens ?? cacheWriteFromStart
                // R33-4（三十三轮）：末见 wins 改逐字段 merge——此前 input 有
                // inputTokensFromStart 兜底、cache 两档有 message_start 兜底，唯
                // output_tokens 缺失直接 ?? 0：部分上游连发多条 message_delta（本文件
                // :199 注释已认的 cc-switch 形态）且末条缺该字段时，此前 delta 已报的
                // 正确 output 值被清零（computeCallCost 输出档计 0、预算闸少计）。
                // prevUsage 显式断言拓宽 TS 对 latestUsage 的 null 收窄（注解不拓宽
                // const 初始化收窄；循环回边处真实类型是 TokenUsage | null）。
                const prevUsage = latestUsage as TokenUsage | null
                latestUsage = {
                  inputTokens: event.usage.input_tokens ?? prevUsage?.inputTokens ?? inputTokensFromStart,
                  outputTokens: event.usage.output_tokens ?? prevUsage?.outputTokens ?? 0,
                  ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
                  ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
                }
              }
              break;
            }
          }
        }

        // 兜底（H-2 第六轮）：流结束未发 done 的两种情形必须分流——与 OpenAI 线 L5-1
        // sawFinishReason / Responses 线 R1 同款契约：
        // ① 到过 message_delta（stop_reason 已缓存）但无 usage → 网关完成不回 usage，
        //    放行生成（0 成本是可得最优估计的旧取舍已被 R73-1 升级）：input 优先用
        //    message_start 缓存的实测值，缺失才按请求字符折算；output 按累计产出
        //    （text_delta + tool jsonBuf）折算；estimated 标记估计口径（修复前 output
        //    恒 0，预算闸 tokens/cost 对该类端点永不生效、成本报表系统性偏低）；
        // ② 连 message_delta 都没到 → 传输截断（中转/代理提前断流时 SDK 迭代器不抛错
        //    而是正常 return 的形态），报可重试错误不发 done——半截正文不得当完整产出
        //    落稿、不得按成功 0 成本入账、必须进重试路径。修复前两种情形混同，截断流
        //    被伪造成 end_turn 正常完成。
        // R30-13（三十轮）登记维持：stopReason 命名三线未归一——本线透传上游原生值
        //（'end_turn'/'max_tokens'/'tool_use'/…），openai/responses 两线自然完成发 'stop'
        //（其余值已各自归一：'length'→'max_tokens'、'tool_calls'→'tool_use'）。收敛为规范
        // 枚举影响面超 4 文件（gen/runner 缺省值 + 15 个断言 'end_turn' 的测试），且现
        // 消费方只判 'max_tokens'（截断重写）与 toolCalls 非空，命名差异无实害——维持登记。
        if (!doneEmitted) {
          // R27-2（二十七轮）：流末统一 emit——末见 usage 优先（上面 message_delta 只记
          // 不发）；无 usage 才走估计/截断兜底（与 openai 线 R26-3 同构）
          // R33D-2（三十三轮）：refusal 不是正常完成——stop_reason 原生透传口径（R30-13
          // 登记）下该值此前按成功 done 出场，被过滤的半截正文按成功落稿（openai 线
          // content_filter / responses 线 R1 缺口 2 同因判 error，三线分叉）。error 出场
          // （retryable:false，usage 随错上抛）。
          if (latestUsage) {
            if (pendingStopReason === 'refusal') {
              yield {
                type: 'error',
                message: '生成被内容过滤截断（stop_reason=refusal）——半截产出不落稿，请调整提示词后重试',
                retryable: false,
                code: 'PROTOCOL',
                usage: latestUsage,
              }
              return
            }
            const ev = emitDone(latestUsage, pendingStopReason ?? 'end_turn')
            if (ev) yield ev
          } else if (pendingStopReason !== null) {
            for (const [, tb] of toolBlocks) outToolText.push(tb.name + tb.jsonBuf) // R73-1：tool 参数计入产出累计
            const usage: TokenUsage = {
              inputTokens:
                inputTokensFromStart > 0
                  ? inputTokensFromStart // message_start 实测值优先（真实输入计量）
                  : estimateInputTokens(req, conf.model ?? undefined),
              outputTokens: estimateOutputTokens(outText.join('') + outToolText.join(''), conf.model ?? undefined),
              // R74-7（二十二轮批 A）：message_start 已实测的 cache 两档原样保留——R73-1
              // 整包重估输入时丢弃，usage 四档分计在兜底路径少两档（cache 计费面被清零）；
              // anthropic 的 input_tokens 不含 cache（D4 独立记账），并档不双计
              ...(cacheReadFromStart !== undefined ? { cacheReadTokens: cacheReadFromStart } : {}),
              ...(cacheWriteFromStart !== undefined ? { cacheWriteTokens: cacheWriteFromStart } : {}),
              estimated: true,
            }
            // R33D-2：无 usage 的 refusal 同款判错（估计 usage 随错上抛）
            if (pendingStopReason === 'refusal') {
              yield {
                type: 'error',
                message: '生成被内容过滤截断（stop_reason=refusal）——半截产出不落稿，请调整提示词后重试',
                retryable: false,
                code: 'PROTOCOL',
                usage,
              }
              return
            }
            const ev = emitDone(usage, pendingStopReason)
            if (ev) yield ev
          } else {
            // R32-1（三十二轮）：截断 error 随错上抛已发生消耗（R31-1 openai 线同口径，
            // B-12 通道）——message_start 实测 input/cache 优先（本分支 latestUsage 必为
            // null，见上），output 按累计产出折算，标 estimated；截断不再丢已发生计费。
            for (const [, tb] of toolBlocks) outToolText.push(tb.name + tb.jsonBuf)
            yield {
              type: 'error',
              message: '传输截断：流结束无终止事件',
              retryable: true,
              code: 'NETWORK',
              usage: {
                inputTokens:
                  inputTokensFromStart > 0
                    ? inputTokensFromStart
                    : estimateInputTokens(req, conf.model ?? undefined),
                outputTokens: estimateOutputTokens(outText.join('') + outToolText.join(''), conf.model ?? undefined),
                ...(cacheReadFromStart !== undefined ? { cacheReadTokens: cacheReadFromStart } : {}),
                ...(cacheWriteFromStart !== undefined ? { cacheWriteTokens: cacheWriteFromStart } : {}),
                estimated: true,
              },
            }
          }
        }
      } catch (e) {
        yield toErrorEvent(e)
      }
    },
  }
}

