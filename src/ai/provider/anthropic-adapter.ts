/**
 * Anthropic 协议适配器（方案 §四①）。
 *
 * 使用 @anthropic-ai/sdk，baseURL 与凭据全部来自用户配置的 ProviderConf。
 * auth 决定发 x-api-key（官方）还是 Bearer（中转，authToken）。
 *
 * effort 翻译为 output_config.effort；thinking 不发（走模型默认 adaptive）。
 * claude 原生 + effort 组合显式禁思考（thinking:{type:'disabled'}）——
 * 扩展思考块若产出，多轮工具链要求回传带签名块（Anthropic 硬要求，零回传 400）。
 * 流侧 thinking 文本以 reasoning 事件透出（三线口径对齐 openai/responses）。
 * 曾把 thinking/redacted_thinking 块（含签名）缓存在流内
 * Map（thinkingBlocks），但零后续消费（签名纯滞留）——死存储已移除；完整回传
 * （带签名块进 ChatMsg）待跨批需求落地时按需重建（见 toParams 禁思考注 /
 * toAnthropicMessage 注）。
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
  StopReason,
} from './types.js'
import type { ProviderStore } from './store.js'
import { modelConfOf } from './store.js'
import { quirksFor, detectFamily, CLAUDE_SAFE_MAX_OUTPUT_TOKENS } from './model-quirks.js'
import { resolveToolChoiceIntent } from './tool-choice.js' // tool_choice 分档决策单源
import { anthropicClientOpts, normalizeBaseUrl } from './models.js'
import { makeToErrorEvent, buildDegradeAttempts, isMidChain400, markStructuredDegrade } from './adapter-errors.js'
import {
  createStreamFinalizer,
  normalizeStopReason,
  type EstimateUsageSources,
  type StreamFinalizer,
} from './stream-finalize.js'

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
 * 构造参数统一走 models.anthropicClientOpts（env 污染双向阻断的单一
 * 真相源——claudeAuth/bearer 分支 apiKey:null 防止 SDK 回退读 env
 * ANTHROPIC_API_KEY 造成双认证头；此处原先的私有副本漏了该防线）。
 */
function createClient(conf: ProviderConf): Anthropic {
  const auth = conf.auth ?? 'anthropic'
  // baseUrl 归一走 models.normalizeBaseUrl 单源——原本文件私有
  // normalizeAnthropicBaseUrl 与它逐字同义（去尾斜杠 + 剥尾部 /v1），两份副本改一漏一
  // 即静默分叉（同一地址探测与请求两路归一不同的口子）。
  return new Anthropic(anthropicClientOpts(normalizeBaseUrl(conf.baseUrl, 'anthropic'), conf.apiKey, auth))
}

/** Anthropic API 强制要求 max_tokens（不可省略）——协议兜底值单源见
 *  model-quirks.CLAUDE_SAFE_MAX_OUTPUT_TOKENS（= quirks 表 claude 档 maxOutputTokens）：
 *  unknown 家族模型走此兜底时长章必截断，且 MAX_TOKENS 是终态不可重试；该值为现役
 *  claude 安全下限（对旧模型 128000 才 400，16384 无此问题）。 */

/** tool_use.input 归一——ChatMsg 历史
 *  的 input 形状是 unknown（跨协议回放：Responses/OpenAI 线产出合法 JSON 非对象形态
 *  如数字/字符串/数组时原样入库），Anthropic 线 input 必须是 object，原 `as` 断言吞
 *  形状后非对象裸传网关 400。窄兜底 {_raw} 保真载荷（与 responses-adapter parse
 *  失败兜底同款口径），fail-visible 不丢参数。 */
function toolInputForAnthropic(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { _raw: input }
}

/** ChatMsg → Anthropic 线格式 message（纯文本直传；block 数组逐项映射）。
 * 映射后 content 为空数组（block 全为 reasoning 的消息）→ 返回 null，
 *  由 toParams 从请求历史剔除（见 toParams 处注）。 */
function toAnthropicMessage(m: ChatMsg): Anthropic.MessageParam | null {
  if (typeof m.content === 'string') return { role: m.role, content: m.content }
  // block 数组 → Anthropic content block
  const blocks: Anthropic.ContentBlockParam[] = m.content.flatMap(
    (b: ClwContentBlock): Anthropic.ContentBlockParam[] => {
      // 空串 text 块跳过——Anthropic API 对空 text 块 400，此前原样
      // 透传，正确性隐式依赖上游 sanitizeHistory 防线（记档的耦合）；防御内置后
      // 该耦合解除。跳过后整消息无块 → 走下方空数组 → null 的剔除路径兜住
      if (b.type === 'text') return b.text === '' ? [] : [{ type: 'text', text: b.text }]
      // reasoning 块（chat 侧 DeepSeek/Kimi 回传产物）→ 原生端点无此字段，静默丢弃（方案 §4.2）。
      // 记档：正确性曾依赖上游 sanitizeHistory 先剥离——若未来上游
      // 防线移除，此处丢弃即最后一道（仅丢回传推理文本，不损对话内容，风险可接受）；
      // 空 text 块防御已内置（见上），该隐式耦合解除
      if (b.type === 'reasoning') return []
      // 注：Anthropic 扩展思考块的完整回传（带签名 thinking 块）需要
      // 在 ContentBlock 增加 thinking/redacted_thinking 变体 + gen/turns 侧签名载道——
      // 类型扩展会击穿 usage-estimate.flattenMsgContent 的 exhaust 分支（该文件不在本轮
      // 可修清单），故回传侧零透传维持；防 400 由 toParams 的 claude+effort 显式禁思考
      //（主防线）+ 上一条 reasoning 块丢弃（次防线）承担，完整回传留待跨批接通。
      if (b.type === 'tool_use')
        return [{ type: 'tool_use', id: b.id, name: b.name, input: toolInputForAnthropic(b.input) }]
      // tool_result: Anthropic 要求挂在 user 消息里，toolUseId → tool_use_id
      return [
        { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) },
      ]
    },
  )
  // 全 reasoning 消息 flatMap 产出空数组 → null（toParams 过滤剔除）
  if (blocks.length === 0) return null
  return { role: m.role, content: blocks }
}

/** 输出上限 resolve 单源——toParams 上线值与 done 事件透出值同源，
 *  防两处各写一份漂移（anthropic 线全链兜底：调用方 cap → 模型行 → quirks 表 →
 *  CLAUDE_SAFE_MAX_OUTPUT_TOKENS 协议兜底；原「→ 8192」系上调后的注释漂移漏网） */
function resolveMaxTokens(conf: ProviderConf, req: GenRequest): number {
  return (
    req.maxTokens ??
    modelConfOf(conf)?.maxTokens ??
    quirksFor(conf.model ?? '').maxOutputTokens ??
    CLAUDE_SAFE_MAX_OUTPUT_TOKENS
  )
}

/** GenRequest → Anthropic MessageCreateParams */
function toParams(conf: ProviderConf, req: GenRequest): Anthropic.MessageCreateParamsStreaming {
  // 表驱动参数翻译（表驱动重构 §6.1）
  const q = quirksFor(conf.model ?? '')

  const params: Anthropic.MessageCreateParamsStreaming = {
    model: conf.model ?? '',
    // #5：max_tokens 用表值（如 claude 16384 / deepseek 384000），兜底
    // CLAUDE_SAFE_MAX_OUTPUT_TOKENS（单源；原「兜底 8192」为漂移残留）。
    // 阶段 14 §7.2 显式 resolve：调用方 cap（req.maxTokens）→ 模型行覆盖（用户声明）→ quirks 表 → 协议兜底。
    max_tokens: resolveMaxTokens(conf, req),
    // 仅 reasoning block 的 assistant 轮 flatMap 产出 content:[]，
    // Anthropic API 对空 content 数组 400——上游 sanitizeHistory 剥离是常规防线但非保证
    //（本适配器是最后防线）：无可渲染内容的轮次整条从请求历史剔除（text/tool_use/
    // tool_result 任一存在即保留；剔除后同 role 相邻消息由 Anthropic 端点合并为一轮）。
    messages: req.messages.map(toAnthropicMessage).filter((m): m is Anthropic.MessageParam => m !== null),
    stream: true,
    // #4：空 system 不发字段（对齐 OpenAI 侧守卫，严格中转 system:"" 可 400）
    ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
  }
  // tool_result 关联拒绝，按块 index 生成兜底（对齐 OpenAI 线）
  if (req.tools?.length) {
    params['tools'] = req.tools.map(toAnthropicTool)
  }
  // tool_choice 按表 toolChoiceMode 翻译（对齐 openai-adapter §6.1）：分档决策
  // 单源见 tool-choice.ts（三适配器同构 if 树收敛），此处只留动作 → wire
  // 值发射：force → {type:'any'}、force-named → {type:'tool',name}、auto → {type:'auto'}，
  // none → 不发。#12：disable_parallel_tool_use 仅 parallelControl 为真才发
  const dptu = q.parallelControl ? { disable_parallel_tool_use: true } : {}
  if (req.toolChoice && q.toolChoiceMode !== 'none') {
    const intent = resolveToolChoiceIntent({
      toolChoiceMode: q.toolChoiceMode,
      toolChoice: req.toolChoice,
      toolName: req.toolName,
    })
    if (intent.action === 'force') {
      // named 档 = 'any' 原样；required 档 = 指名意图降级为 any（deepseek 400 防线）
      params['tool_choice'] = { type: 'any', ...dptu }
    } else if (intent.action === 'force-named') {
      params['tool_choice'] = { type: 'tool', name: intent.name, ...dptu }
    } else if (intent.action === 'auto') {
      params['tool_choice'] = { type: 'auto', ...dptu }
    }
  }
  // #2：effort 仅当表 anthropicEffortWire=output_config 才发（claude/deepseek），
  // 其余厂家的 anthropic 端点文档缺失 → 保守不发。档位收敛用 effortMap。
  if (req.effort && q.anthropicEffortWire === 'output_config') {
    const mapped = q.effortMap?.[req.effort] ?? req.effort
    params['output_config'] = { effort: mapped }
    //
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
  // stop sequences——对齐 openai 线 q.trimStop（各家上限不同、
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

/* ── 流消费分解：建流降级编排 / 单事件消费 / 流末收尾各自成函数，stream 主体只留
 *「建流 → 逐事件消费 → 收尾」骨架；终止值与 flag 更新留在主体（流级状态）。──
 * 与 openai 线同构（那边是 consumeChunk / settleStream / attemptUsageNow），差异只在
 * 各线 wire 形态：本线的用量在 message_delta 逐字段 merge、截断判据是「有无终止值」。 */

/** 流级累计：一次 stream 调用一份，跨事件覆盖式更新（attempt 循环在建流侧、消费在循环外，
 *  本线天然不重跑，故无「半截累计泄入下一 attempt」面） */
interface StreamAcc {
  /** message_start 带 input_tokens；message_delta 一般只有 output_tokens */
  inputTokensFromStart: number
  /** message_start 的 cache 读/写量（message_delta 缺字段时兜底） */
  cacheReadFromStart: number | undefined
  cacheWriteFromStart: number | undefined
  /** 流内逐 delta 覆盖，流末统一 emit（末见 wins） */
  latestUsage: TokenUsage | null
  /** 缓存归一后的终止值——捕获点即归一枚举（非标拼写归 'unknown' 并留痕） */
  pendingStopReason: StopReason | null
  /** 产出累计（text_delta 与 thinking_delta 串联 + tool jsonBuf）——网关吞 usage 时按此
   *  折算估计用量（usage-estimate.ts 同源系数），不再按 0 输出入账 */
  outText: string[]
  outToolText: string[]
  /** tool_use input 增量拼装：content_block_start 记 tool name，input_json_delta 增量拼
   *  JSON 字符串，content_block_stop 时整体解析 */
  toolBlocks: Map<number, { id: string; name: string; jsonBuf: string }>
}

/** 流级累计初始化（每次 stream 调用新建一次——声明点原在 try 块内的消费段，外层 catch
 *  取不到异常时点的估计用量信号，故声明上移到流级作用域，语义不变） */
function createStreamAcc(): StreamAcc {
  return {
    inputTokensFromStart: 0,
    cacheReadFromStart: undefined,
    cacheWriteFromStart: undefined,
    latestUsage: null,
    pendingStopReason: null,
    outText: [],
    outToolText: [],
    toolBlocks: new Map(),
  }
}

/** 估计用量输入单点（在途 toolBlocks 一并计入产出折算）——估计分支、截断分支、异常 catch
 *  三处同源，防三份各写各的信号清单漂移 */
function lateSourcesOf(conf: ProviderConf, req: GenRequest, acc: StreamAcc): EstimateUsageSources {
  return {
    req,
    model: conf.model ?? undefined,
    outText: acc.outText,
    outToolText: acc.outToolText,
    pendingToolText: [...acc.toolBlocks.values()].map((tb) => tb.name + tb.jsonBuf),
    measuredInputTokens: acc.inputTokensFromStart,
    ...(acc.cacheReadFromStart !== undefined ? { cacheReadTokens: acc.cacheReadFromStart } : {}),
    ...(acc.cacheWriteFromStart !== undefined ? { cacheWriteTokens: acc.cacheWriteFromStart } : {}),
  }
}

/** message_delta 的 usage 面：input 与 cache 两档线上可缺（SDK 标 nullable），
 *  output_tokens 是必填计量——「真实 usage」闸只看前两者是否在位（见 message_delta 分支注）。 */
type WireDeltaUsage = Anthropic.RawMessageDeltaEvent['usage']

/** message_delta usage 逐字段 merge（末见 wins，但缺字段保留前值而非清零）：
 *  - input：本 delta 值 ?? 前值 ?? message_start 缓存值；
 *  - cache 两档：本 delta 值 ?? 前值 ?? message_start 缓存值——非标网关「message_start 缺
 *    cache + 首条 delta 带 cache + 末条 delta 又缺」三条件叠加时，先前 delta 已报的 cache
 *    值不得被丢（丢了 latestUsage 整段无 cache 计量，computeCallCost 缓存档计 0）；
 *  - output：本 delta 值 ?? 前值；两档都缺才归 0（非标网关逐 delta 回 usage 且末条
 *    缺该字段时，先前已报的正确 output 值不得被清零——computeCallCost 输出档计 0、预算闸少计）。
 *  缺失档不产键（undefined 不入对象），与实测 usage 的字段形态一致。 */
function mergeDeltaUsage(
  usage: WireDeltaUsage,
  prevUsage: TokenUsage | null,
  inputTokensFromStart: number,
  cacheReadFromStart: number | undefined,
  cacheWriteFromStart: number | undefined,
): TokenUsage {
  const cacheRead = usage.cache_read_input_tokens ?? prevUsage?.cacheReadTokens ?? cacheReadFromStart
  const cacheWrite = usage.cache_creation_input_tokens ?? prevUsage?.cacheWriteTokens ?? cacheWriteFromStart
  return {
    inputTokens: usage.input_tokens ?? prevUsage?.inputTokens ?? inputTokensFromStart,
    outputTokens: usage.output_tokens ?? prevUsage?.outputTokens ?? 0,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

/**
 * 消费一个流事件：message_start 捕获起始用量 → content_block_* 增量透出并按需拼装 tool →
 * message_delta 落终止值与用量。纯转发事件（text/reasoning/tool）即时 yield，跨事件状态只写
 * acc（流级状态与 done 判定留在调用方）。
 */
function* consumeStreamEvent(event: Anthropic.RawMessageStreamEvent, acc: StreamAcc): Generator<GenEvent, void, void> {
  switch (event.type) {
    case 'message_start': {
      // input_tokens 在 message_start（message_delta 一般不含）；cache 读/写量同点捕获
      // （Anthropic input_tokens 不含 cache，独立记账）。
      // ?? 0 终兜底——非标网关 message_start 缺 input_tokens 时原样赋 undefined 会覆盖
      // 声明侧的 0 初值，下游 TokenUsage.inputTokens 变 undefined → calls 记账 += 得 NaN
      // → checkAiCallBudget 对 NaN 恒 false，该进程内 token/成本预算闸静默失效（cache/output
      // 侧均有 ?? 兜底，唯此处漏）
      acc.inputTokensFromStart = event.message.usage.input_tokens ?? 0
      acc.cacheReadFromStart = event.message.usage.cache_read_input_tokens ?? undefined
      acc.cacheWriteFromStart = event.message.usage.cache_creation_input_tokens ?? undefined
      return
    }
    case 'content_block_start': {
      const block = event.content_block
      if (block.type === 'tool_use') {
        // 非官方兼容端点可能不发 id——空 id 进历史会被 tool_result 关联拒绝，
        // 按块 index 生成兜底（对齐 OpenAI 线）
        acc.toolBlocks.set(event.index, { id: block.id || `toolu_${event.index}`, name: block.name, jsonBuf: '' })
      }
      // thinking / redacted_thinking 块 start 无操作——流内块缓存（含签名）为死存储已移除；
      // thinking 文本仍经下方 thinking_delta 分支以 reasoning 事件透出，行为不变
      return
    }
    case 'content_block_delta': {
      const delta = event.delta
      if (delta.type === 'text_delta') {
        // 产出累计与事件透出同步——回传历史另经 toAnthropicMessage，此处只影响估计入账
        acc.outText.push(delta.text)
        yield { type: 'text', delta: delta.text }
      } else if (delta.type === 'input_json_delta') {
        const tb = acc.toolBlocks.get(event.index)
        if (tb) tb.jsonBuf += delta.partial_json
      } else if (delta.type === 'thinking_delta') {
        // 思考增量即刻以 reasoning 事件透出（对齐 openai 线 reasoning_content /
        // responses 线 reasoning_text 口径）；文本入产出累计（思考 token 也是真实计费面，
        // 与 Anthropic output_tokens 含思考 token 的口径一致）
        acc.outText.push(delta.thinking)
        yield { type: 'reasoning', delta: delta.thinking }
      }
      return
    }
    case 'content_block_stop': {
      const tb = acc.toolBlocks.get(event.index)
      if (tb) {
        let input: unknown
        try {
          input = tb.jsonBuf ? JSON.parse(tb.jsonBuf) : {}
        } catch {
          input = { _raw: tb.jsonBuf }
        }
        yield { type: 'tool', id: tb.id, name: tb.name, input }
        // stop 即消费条目——非标网关对同一 index 重发 content_block_stop 时原样滞留会重复
        // 产出同 id tool_use（下游同 id 写历史两条，回传 400）。tool 参数产出累计也在消费时
        // 入 outToolText，流异常兜底（lateSourcesOf 逐条推送只余未 stop 残块）的折算口径
        // 与消费前一致。
        acc.outToolText.push(tb.name + tb.jsonBuf)
        acc.toolBlocks.delete(event.index)
      }
      return
    }
    case 'message_delta': {
      // 缓存 stop_reason（即使无 usage 也不丢）——捕获点即归一（本线原生值即归一值；
      // 非标拼写归 'unknown' 并留痕），done / llm-call 的重放口径自此收敛到判别联合
      if (event.delta?.stop_reason) {
        acc.pendingStopReason = normalizeStopReason(event.delta.stop_reason, 'anthropic')
      }
      // 最终 usage + stop_reason 在 message_delta 里（input_tokens 合并 message_start 缓存）。
      // 只记 latestUsage 不即席 emit——逐 delta 回 usage 的网关（早期部分值 + 末条完整值）
      // 在流末统一按末见 wins 取值，与 openai 线口径一致。
      // 空 usage 对象（{} truthy 但无计量字段）等价「无 usage」——原样进 merge 会把
      // latestUsage 置成 input=message_start 兜底、output=0 的假计量，流末 done 走实测分支
      // 绕过估计兜底。对齐 openai 线 isRealUsage 口径：input/output 至少一个在位才采信，
      // {} 落到流末估计分支（cache 两档不计入该闸——线上可为 null，单凭它采信会引入
      // 无 input/output 的假计量）。
      if (event.usage && (event.usage.input_tokens !== undefined || event.usage.output_tokens !== undefined)) {
        // prevUsage 显式取前值交 merge（cache 两档链与 input/output 兜底都引用它；
        // 未置位时为 null，merge 内以 message_start 缓存值殿后）
        const prevUsage: TokenUsage | null = acc.latestUsage
        acc.latestUsage = mergeDeltaUsage(
          event.usage,
          prevUsage,
          acc.inputTokensFromStart,
          acc.cacheReadFromStart,
          acc.cacheWriteFromStart,
        )
      }
      return
    }
  }
}

/**
 * 流末收尾（事件循环之后）：只产「过滤/拒答 error」「done」「截断 error」三者之一。
 *
 * 分流判据（与 openai 线的 settleStream 同构，差异只在信号的可得形态）：
 * - 有实测 usage → 先判 refusal（error 出场），否则 done 带末见 usage；
 * - 无 usage 但到过 message_delta（终止值已缓存）→ 网关完成不回 usage，放行生成：input 优先
 *   message_start 实测值、缺失才按请求字符折算，output 按累计产出折算，estimated 标估计口径
 *   （否则 output 恒 0，预算闸 tokens/cost 对该类端点永不生效），同款先判 refusal；
 * - 连终止值都没有 → 传输截断（中转/代理提前断流时 SDK 迭代器不抛错而是正常 return 的形态），
 *   报可重试错误不发 done——半截正文不得当完整产出落稿、不得按成功 0 成本入账。
 *   两情形混同会把截断流伪造成 end_turn 正常完成。
 *
 * usage 随错上抛：截断 error 与（无 usage 的）refusal error 均带估计用量，已发生消耗不被丢。
 */
function* settleStream(
  acc: StreamAcc,
  fin: StreamFinalizer,
  req: GenRequest,
  conf: ProviderConf,
): Generator<GenEvent, void, void> {
  const pending = acc.pendingStopReason
  if (acc.latestUsage) {
    const filtered = fin.filterError(acc.latestUsage, pending)
    if (filtered) {
      yield filtered
      return
    }
    const ev = fin.done(acc.latestUsage, pending)
    if (ev) yield ev
    return
  }
  if (pending !== null) {
    // 在途 toolBlocks 经 lateSourcesOf.pendingToolText 计入产出累计；message_start 已实测的
    // cache 两档原样保留（整包重估输入时丢弃会让四档分计在兜底路径少两档、cache 计费面被清零；
    // anthropic 的 input_tokens 不含 cache，独立记账不双计）
    const usage = fin.estimateUsage(lateSourcesOf(conf, req, acc))
    const filtered = fin.filterError(usage, pending)
    if (filtered) {
      yield filtered
      return
    }
    const ev = fin.done(usage, pending)
    if (ev) yield ev
    return
  }
  yield fin.truncatedError(fin.estimateUsage(lateSourcesOf(conf, req, acc)))
}

/**
 * 400 降级链建流（方案 §6.5）：attempts 构造 / 400 续跑闸 / 记忆写入走 adapter-errors 公共
 * 实现，「连接期异常可安全换参数面重试、流中异常不重跑」的约定见其注释；本线的消费循环在
 * attempts 循环之外，天然不重跑（半截产出不会泄入下一 attempt）。携来源 userDataPath——
 * 降级记忆读/写按显式 path 分发。
 * 返回值 degraded 只在「建流成功」这一支有意义：建的流吃的是非首发（降级）参数面时置位，
 * done 事件据此透出（重放按事件重建会再 400 的口径缺口闭合）。
 */
async function openStreamWithDegrade(
  req: GenRequest,
  conf: ProviderConf,
  client: Anthropic,
  signal: AbortSignal,
  store: ProviderStore | undefined,
  userDataPath: string | undefined,
): Promise<{ stream: AsyncIterable<Anthropic.RawMessageStreamEvent>; degraded: boolean }> {
  const q = quirksFor(conf.model ?? '')
  const plan = buildDegradeAttempts(req, q.structuredMode, conf, store, userDataPath)
  let lastErr: unknown = null
  for (const attempt of plan.attempts) {
    try {
      const stream = await client.messages.create(toParams(conf, attempt), { signal })
      markStructuredDegrade(plan, attempt, store)
      // 成功建流用的是非首发（降级）参数面 → done 事件带 degraded。判据基准是
      // plan.original——记忆命中时 attempts[0] 已是剥除版，拿它当基准对首发恒 false，
      // 记忆命中路径（常态）会漏标 degraded
      return { stream, degraded: attempt !== plan.original }
    } catch (e) {
      if (isMidChain400(e, Anthropic.APIError, attempt, plan)) {
        lastErr = e
        continue
      }
      throw e
    }
  }
  // 全部 attempt 都是非末位 400 才走到此（末位 400 由 isMidChain400 挡下并抛出）
  throw lastErr
}

export function createAnthropicProvider(
  conf: ProviderConf,
  client?: Anthropic,
  store?: ProviderStore,
  userDataPath?: string,
): ModelProvider {
  const c = client ?? createClient(conf)

  return {
    conf,

    async *stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> {
      const acc = createStreamAcc()
      // 流是否已开始消费——外层 catch 据此决定 usage 随错上抛与否
      // （建连期异常无任何消耗，不得按估计值虚报入账）
      let consumedAny = false
      let degraded = false // 成功建流是否用了降级参数面（fin.isDegraded 闭包读）
      // resolve 后终值随 done 透出（降级链 attempt 不改 maxTokens，
      // 按原始 req 计算与各 attempt toParams 上线值一致）
      const resolvedMaxTokens = resolveMaxTokens(conf, req)
      // done 发射 / 过滤判错（refusal）/ 截断估算 / usage 兜底收口单点
      // （三线共用，见 stream-finalize.ts）。missingStopReason 是本线协议口径的显式声明：
      // message_delta 下发 usage 却不带 stop_reason = 回合正常结束（原 `?? 'end_turn'` 就地兜底）
      const fin = createStreamFinalizer({
        line: 'anthropic',
        stopField: 'stop_reason',
        resolvedMaxTokens,
        isDegraded: () => degraded,
        missingStopReason: 'end_turn',
      })
      // 异常时点的可得用量——① 已实测（latestUsage 末见值）优先，② 缺失才按累计产出折算
      // （与截断分支同源公式），estimated 标记估计口径；供外层 catch 交 toErrorEvent
      // 随错上抛（runner 终态失败按真实消耗入账）
      const errorUsage = (): TokenUsage => acc.latestUsage ?? fin.estimateUsage(lateSourcesOf(conf, req, acc))

      try {
        const opened = await openStreamWithDegrade(req, conf, c, signal, store, userDataPath)
        degraded = opened.degraded

        for await (const event of opened.stream) {
          consumedAny = true // 进流即算已消费（catch 侧 usage 上抛门）
          yield* consumeStreamEvent(event, acc)
        }

        // 流末兜底的三情形分流（实测 usage / 估计兜底 / 传输截断）见 settleStream 头注
        if (!fin.doneEmitted()) yield* settleStream(acc, fin, req, conf)
      } catch (e) {
        // 流中 SDK 直接 throw（mid-stream 连接重置等）此前恒裸传——message_start 已实测的
        // input/cache 与流内产出随异常蒸发，runner 终态失败按 0 入账。已消费过流才折算估计
        // 用量随错上抛（未消费 = 建连期异常，无消耗，不得虚报；与 400 降级续跑只在未消费流时
        // 安全的判据同源）。
        yield toErrorEvent(e, consumedAny ? errorUsage() : undefined)
      }
    },
  }
}
