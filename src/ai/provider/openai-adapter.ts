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
 * 400 降级链：structured（json_schema）→ effort，连接期异常未 yield 可安全重试
 * （公共实现与约定见 adapter-errors.ts）。
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
  StopReason,
} from './types.js'
import type { ProviderStore } from './store.js'
import { modelConfOf } from './store.js'
import { quirksFor, type FamilyQuirks } from './model-quirks.js'
import { normalizeBaseUrl } from './models.js' // baseUrl 归单单源——本线传 'openai'（只去尾斜杠，不剥 /v1）
import { resolveToolChoiceIntent } from './tool-choice.js' // tool_choice 按表 toolChoiceMode 翻译（表驱动重构 §6.1）：分档决策单源见
import { makeToErrorEvent, buildDegradeAttempts, runDegradeAttempts, markStructuredDegrade } from './adapter-errors.js'
import { createStreamFinalizer, normalizeStopReason, type StreamFinalizer } from './stream-finalize.js'

/** SDK 异常 → GenEvent.error：公共工厂实现（adapter-errors），此处只贴本线错误类与 label */
const toErrorEvent = makeToErrorEvent({
  APIError: OpenAI.APIError,
  APIUserAbortError: OpenAI.APIUserAbortError,
  APIConnectionError: OpenAI.APIConnectionError,
  label: 'OpenAI API',
})

/** 创建 OpenAI 客户端（baseUrl 归一 走 models.normalizeBaseUrl 单源） */
function createClient(conf: ProviderConf): OpenAI {
  return new OpenAI({
    apiKey: conf.apiKey,
    baseURL: normalizeBaseUrl(conf.baseUrl, 'openai'),
    // SDK 内建重试关闭——runner 重试层是唯一重试决策方
    //（Retry-After/退避都在那）；SDK 默认 maxRetries=2 会叠加放大 HTTP 请求
    //（runTask 4 attempts × SDK 3 = 12 次）且 SDK 退避消耗 60s 首字节窗
    maxRetries: 0,
  })
}

/**
 * ChatMsg → OpenAI 线格式 message 列表（纯文本直传；block 数组展开）。
 *
 * OpenAI 与 Anthropic 的 tool 往返形状根本不同：
 * - assistant 的 tool_use → tool_calls 数组（arguments 须 JSON.stringify）
 * - user 的 tool_result → **独立** role:'tool' 消息（每个 tool_call 一条）
 * - 同一条 user 含 N 个 tool_result → 展开 N 条 role:'tool'
 *
 * echoReasoning 档位消费——历史 assistant 的 reasoning 块是否回写
 * reasoning_content 由家族表决定（true=DeepSeek/Kimi/GLM 思考模型多轮硬要求；
 * false=多数族端点无此字段、严格校验入参的会 400）。无条件回写会让会话中途从
 * true 族端点切到 false 族（OpenAI 官方等）后携带非法字段 → 每次请求持久
 * 400 会话死锁。与 responses 线 responsesWire.echoReasoning（strip/encrypted/none）
 * 对称，本线为布尔两态。reasoning 块本体在 ChatMsg 内保留（AI 链路守则：模型可见
 * ⟺ 已记录），此处只管 wire 序列化形态。
 *
 * 按 SDK 消息类型构造（返回值须可直接进 create 的 messages）——
 * reasoning_content 用交叉类型表达为厂商扩展，不再整数组断言。
 */
function toOpenAIMessages(m: ChatMsg, echoReasoning: boolean): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  if (typeof m.content === 'string') return [{ role: m.role, content: m.content }]

  // block 数组：分离 text/tool_use(tool_calls) 和 tool_result
  const textParts: string[] = []
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] = []
  const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = []

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

  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  // assistant 消息：text + reasoning_content + tool_calls
  if (m.role === 'assistant') {
    // 思维链往返（DeepSeek/Kimi 思考模型硬要求，见方案 §4.2）——reasoning 块写回
    // reasoning_content；档位由 toParams 按家族表注入（见函数头注）。
    // reasoning_content 是 SDK 类型外的厂商扩展（OpenAI 官方端点无此字段）。
    const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
      role: 'assistant',
      content: textParts.join('') || null,
    }
    const reasoning = (m.content as ContentBlock[])
      .filter((b) => b.type === 'reasoning')
      .map((b) => b.text)
      .join('')
    if (reasoning && echoReasoning) msg['reasoning_content'] = reasoning
    if (toolCalls.length > 0) msg['tool_calls'] = toolCalls
    out.push(msg)
  } else {
    // user 消息：纯 text 部分作为 user content；tool_result 展开为独立 role:'tool' 消息
    // tool 消息先出、文本后出——OpenAI 要求 role:'tool' 紧跟 assistant
    // tool_calls，文本插中间会在混合形态下 400；当前链路 tool_result 恒独占 user 消息
    // （responses-adapter 同注），本序修正是防御性口径对齐
    out.push(...toolResults)
    if (textParts.length > 0) out.push({ role: 'user', content: textParts.join('') })
  }
  return out
}

/**
 * 本线 non-SDK 扩展字段——thinking 对象是 DeepSeek 官方双写法
 * （与 reasoning_effort 并存，方案 §4.1），SDK 类型无此字段，用交叉类型逐字段表达，
 * 不再把整个参数对象造进 Record<string, unknown> 后 `as unknown as` 回来（那会
 * 让 SDK 形状校验整段失效）。
 */
type OpenAIChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
  thinking?: { type: 'enabled' }
}

/** GenRequest → OpenAI ChatCompletionCreateParamsStreaming（导出：测试做类型层可赋性断言）。
 * 键插入序 = 请求体 JSON 序——各参数面按既有顺序逐一应用（apply* 族），调用序不得重排。 */
export function toParams(conf: ProviderConf, req: GenRequest): OpenAIChatParams {
  // 参数翻译由 quirks 表驱动（方案 §4.1）——检测不出系列则保守省略可选参数。
  // 上移到消息组装前——历史回写侧（reasoning_content 档位）同样查表
  const q = quirksFor(conf.model ?? '')
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  // 实发 role:'system'（OpenAI 官方兼容别名；developer 角色为更激进约定，暂不采用）
  if (req.systemPrompt) {
    messages.push({ role: 'system', content: req.systemPrompt })
  }
  for (const m of req.messages) {
    messages.push(...toOpenAIMessages(m, q.echoReasoning))
  }

  const params: OpenAIChatParams = {
    // conf.model 可能为 null/undefined（未选模型时），兜底空串防 SDK 报参数错
    model: conf.model ?? '',
    messages,
    stream: true,
  }
  // 参数面逐一应用（顺序即键序）：上限 → tools → 并行控制 → tool_choice → effort → stop
  // → 结构化 → stream_options
  applyTokenCap(params, conf, req, q)
  if (req.tools?.length) {
    params['tools'] = req.tools.map(toOpenAITool)
  }
  // toolChoice 存在（含 'auto'）且 parallelControl 支持 → 关并行工具（parallel_tool_calls:false）。
  // 对齐 anthropic 线（toolChoice 存在即发 disable_parallel_tool_use）——契约
  // 「一轮最多一个工具调用」。注意：parallel_tool_calls 是顶层 chat.completions 参数，
  // 不是 tool_choice 的子字段。
  if (req.toolChoice && q.parallelControl) params['parallel_tool_calls'] = false
  // tool_choice 按表 toolChoiceMode 翻译（分档决策单源见 tool-choice.ts）；none 档不发
  //（prompt 引导兜底）。
  if (req.toolChoice && q.toolChoiceMode !== 'none') {
    applyToolChoiceWire(params, req, q)
  }
  applyReasoningEffort(params, req, q)
  applyStopSequences(params, req, q)
  applyStructuredOutput(params, req, q)
  // 流式 usage（各家支持不同；GLM 无此参数，usage 末 chunk 自带）
  if (q.emitStreamOptions) {
    params['stream_options'] = { include_usage: true }
  }

  return params
}

/** 输出上限（参数名按 quirks 表）——调用方显式 cap（req.maxTokens）优先；其次用户模型行
 * 覆盖（modelConfOf）；仍无 → 不发（quirks 表值不自动补发，防改变请求形状，让模型用自己
 * 的默认值）。 */
function applyTokenCap(params: OpenAIChatParams, conf: ProviderConf, req: GenRequest, q: FamilyQuirks): void {
  const tokenCap = req.maxTokens ?? modelConfOf(conf)?.maxTokens
  if (tokenCap) {
    params[q.maxTokensKey] = tokenCap
  }
}

/** tool_choice 动作 → wire 值发射：force → 'required'；force-named →
 * {type:'function',function:{name}}；auto → 'auto'（'none' 由调用点闸掉）。 */
function applyToolChoiceWire(params: OpenAIChatParams, req: GenRequest, q: FamilyQuirks): void {
  const intent = resolveToolChoiceIntent({
    toolChoiceMode: q.toolChoiceMode,
    toolChoice: req.toolChoice,
    toolName: req.toolName,
  })
  if (intent.action === 'force') {
    params['tool_choice'] = 'required'
  } else if (intent.action === 'force-named') {
    params['tool_choice'] = { type: 'function', function: { name: intent.name } }
  } else if (intent.action === 'auto') {
    params['tool_choice'] = 'auto'
  }
}

/** effort → reasoning_effort（各家档位与支持模型不同，由 quirks 收敛；表返回值域是 SDK
 * ReasoningEffort 子集，直接赋值即受 SDK 类型校验）。DeepSeek 的 thinking 对象与
 * reasoning_effort 两种写法官方并存（方案 §4.1），按表并存发射。 */
function applyReasoningEffort(params: OpenAIChatParams, req: GenRequest, q: FamilyQuirks): void {
  if (!req.effort) return
  const effort = q.reasoningEffort(req.effort)
  if (!effort) return
  params['reasoning_effort'] = effort
  if (q.thinkingWithEffort) params['thinking'] = { type: 'enabled' }
}

/** stop 裁剪（各家上限不同；grok 推理模型不发——trimStop 返 null 即不发）。 */
function applyStopSequences(params: OpenAIChatParams, req: GenRequest, q: FamilyQuirks): void {
  if (!req.stopSequences?.length) return
  const stops = q.trimStop(req.stopSequences)
  if (stops?.length) params['stop'] = stops
}

/** 结构化输出档位（json_schema 400 由降级链剥除；json_object 需 prompt 约束）。 */
function applyStructuredOutput(params: OpenAIChatParams, req: GenRequest, q: FamilyQuirks): void {
  if (!req.structured?.schema || q.structuredMode === 'none') return
  params['response_format'] =
    q.structuredMode === 'json_schema'
      ? { type: 'json_schema', json_schema: { name: 'output', schema: req.structured.schema, strict: true } }
      : { type: 'json_object' }
}

function toOpenAITool(tool: ToolDef): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema,
    },
  }
}

/** OpenAI 兼容线 usage 形态（*_tokens_details 非所有中转都发，可选） */
interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  /** 推理 token 观测位——responses 线已读（output_tokens_details），Chat 线对齐 */
  completion_tokens_details?: { reasoning_tokens?: number }
}

/**
 * 空 usage 对象（{} 或缺两主字段）不算真实计量——逐 truthy 判定会让网关下发的
 * `usage:{}` 落进 latestUsage，流末 toUsage({}) 按 0/0 入账，绕过估计兜底
 * （预算闸 tokens/cost 对该类端点失效、成本报表系统性偏低）。此处把空对象等价于
 * 「无 usage」——与 responses/anthropic 线口径一致（无终止事件时的估计兜底照常生效，
 * estimated 标记区分估计口径）；末见 wins 语义也顺带防住「真实 usage 后再来空对象」的覆盖。
 */
function isRealUsage(u: WireUsage | null | undefined): u is WireUsage {
  return u !== null && u !== undefined && (u.prompt_tokens !== undefined || u.completion_tokens !== undefined)
}

/**
 * usage 线格式 → TokenUsage（prompt_tokens_details.cached_tokens → cacheReadTokens）。
 * 口径：prompt_tokens **已含** cache 命中，边界处扣减归一成「inputTokens 不含 cache 读」
 * 的统一口径（Anthropic 语义），下游计价/预算四档分计公式对两协议同时成立；
 * 中转缺 prompt_tokens_details 时 cached=undefined，行为与旧口径一致。
 *
 * 合理性防御（不得低估）：cached > prompt_tokens 自相矛盾（命中量不可能超总 prompt），
 * 只可能出自把 prompt_tokens 报成「未命中输入」、cached 另行计数的非标网关——此时若仍
 * 按差扣减，整份输入会被扣成 0 并按 cache 读价入账，预算闸/成本报表系统性低估。
 * 该形态改按 prompt_tokens 即 inputTokens（两侧不互含、输入全量入账）；符合官方语义的
 * 网关（cached ≤ prompt_tokens）不触本分支，逐位不变。
 */
function toUsage(u: WireUsage | undefined | null): TokenUsage {
  const prompt = u?.prompt_tokens ?? 0
  const cached = u?.prompt_tokens_details?.cached_tokens
  const reasoning = u?.completion_tokens_details?.reasoning_tokens
  const separateCounters = cached !== undefined && cached > prompt
  return {
    inputTokens: separateCounters ? prompt : Math.max(0, prompt - (cached ?? 0)),
    outputTokens: u?.completion_tokens ?? 0,
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  }
}

/* ── 流消费分解：单 chunk 消费 / tool_calls 拼装 / 流末收尾各自成函数，主流程只留
 *「建流 → 逐 chunk 消费 → 收尾」骨架；终止值与 flag 更新留在主流程（流级状态）。── */

/** tool_calls 分片累加单元（按 index/兜底键聚合，arguments 为增量字符串，末尾整体解析） */
interface ToolCallAcc {
  id: string
  name: string
  argsBuf: string
}

/** 单次 attempt 的流内累计（每次建流新建——上一 attempt 的半截累计不得泄入） */
interface StreamAcc {
  toolAccum: Map<number | string, ToolCallAcc>
  /** 产出累计（文本/推理 delta 串联 + tool 参数）——网关吞 usage 时按此折算估计用量 */
  outText: string[]
  outToolText: string[]
  /** 最后可见 usage（逐 chunk 覆盖，末见 wins）；空对象不算计量（isRealUsage 闸） */
  latestUsage: WireUsage | null
  /** 缺省 tc.index 的兜底聚合序号与最近兜底键（无 index 流也能拆出独立调用） */
  idxlessSeq: number
  lastIdxlessKey: string | null
  /** 兜底 id 流级计数（跨 finish_reason 段不重号） */
  fallbackToolSeq: number
}

/** Chat 线 delta.tool_calls 项（SDK 标 index 必填，非标网关可缺——运行时按可选处理） */
type ChunkToolCall = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall

function createStreamAcc(): StreamAcc {
  return {
    toolAccum: new Map(),
    outText: [],
    outToolText: [],
    latestUsage: null,
    idxlessSeq: 0,
    lastIdxlessKey: null,
    fallbackToolSeq: 0,
  }
}

/**
 * 消费一个流 chunk：usage 落账 → 文本/思维链增量 → tool_calls 分片累加 →
 * finish_reason 段整体产出 tool 事件。返回本 chunk 的 finish_reason（无则 null）——
 * 终止值归一与 sawFinishReason 置位由调用方做（流级状态，跨 attempt 语义）。
 */
function* consumeChunk(
  chunk: OpenAI.Chat.Completions.ChatCompletionChunk,
  acc: StreamAcc,
): Generator<GenEvent, string | null, void> {
  const usage = chunk.usage
  // usage 双兜底：Kimi 文档自相矛盾（usage 可能在 choices[0]；SDK Choice 类型未含该字段，
  // 运行时由厂商端点下发）
  const choiceUsage = (chunk.choices?.[0] as { usage?: WireUsage } | undefined)?.usage
  const effectiveUsage = usage ?? choiceUsage
  // usage 逐 chunk 统一落账（末见 wins）——「choice 在、finish_reason 不在」的先行 usage
  // chunk 也记入，流末统一取最新值 emit（不即席 emit，口径不变）
  if (isRealUsage(effectiveUsage)) acc.latestUsage = effectiveUsage

  const choice = chunk.choices?.[0]
  if (!choice) return null // usage-only chunk（落账已在上方统一完成）

  const delta = choice.delta
  // delta 可能为 null —— 非官方端点偶发，可选链兜底防 TypeError 致 GEN_FAIL
  if (delta?.content) {
    acc.outText.push(delta.content) // 产出累计（推理 token 也是真实计费面）
    yield { type: 'text', delta: delta.content }
  }

  // 思维链增量（DeepSeek/Kimi 思考模型的 reasoning_content）→ reasoning 事件（方案 §4.2）；
  // SDK Delta 类型未含该字段（非官方），运行时由厂商端点下发
  const reasoningDelta = (delta as { reasoning_content?: string } | null)?.reasoning_content
  if (reasoningDelta) {
    acc.outText.push(reasoningDelta) // 产出累计（推理 token 也是真实计费面）
    yield { type: 'reasoning', delta: reasoningDelta }
  }

  // tool_calls 增量（delta 可能为 null——部分网关下发 delta:null 的空 chunk，同款兜底）
  if (delta?.tool_calls) accumulateToolCalls(acc, delta.tool_calls)

  // finish_reason → 发出已拼完的 tool 事件；done 延迟到流末，取最后可见 usage
  if (choice.finish_reason) {
    yield* drainToolCalls(acc)
    return choice.finish_reason
  }
  return null
}

/** delta.tool_calls 分片累加。 */
function accumulateToolCalls(acc: StreamAcc, deltas: readonly ChunkToolCall[]): void {
  for (const tc of deltas) {
    const key = toolCallKeyOf(acc, tc)
    let entry = acc.toolAccum.get(key)
    if (!entry) {
      entry = { id: tc.id ?? '', name: tc.function?.name ?? '', argsBuf: '' }
      acc.toolAccum.set(key, entry)
    }
    if (tc.function?.name) entry.name = tc.function.name
    if (tc.function?.arguments) entry.argsBuf += tc.function.arguments
  }
}

/**
 * 分片聚合键：有 index 原样；缺 index 时新调用分片（带 id/name）开新兜底键、续片归并最近
 * 兜底键（最近键已被 finish_reason 清空则另开）——无 index 流也拆得出独立调用。
 */
function toolCallKeyOf(acc: StreamAcc, tc: ChunkToolCall): number | string {
  if (tc.index !== undefined) return tc.index
  const startsCall = (tc.id !== undefined && tc.id !== '') || !!tc.function?.name
  if (startsCall || acc.lastIdxlessKey === null || !acc.toolAccum.has(acc.lastIdxlessKey)) {
    acc.lastIdxlessKey = `no-index-${++acc.idxlessSeq}`
  }
  return acc.lastIdxlessKey
}

/**
 * 取走已拼装的 tool_calls → tool 事件（逐条产出后清空累计）。有 name 即发出——空 args 合法
 *（无参工具）；非官方端点缺 id 时以 call_ 兜底 id（流级序号，跨 finish_reason 段不重号）；
 * arguments 非合法 JSON 时以 _raw 包装兜底（不吞内容）。
 */
function* drainToolCalls(acc: StreamAcc): Generator<GenEvent, void, void> {
  for (const entry of acc.toolAccum.values()) {
    if (!entry.name) continue
    const input = parseToolArgs(entry.argsBuf)
    acc.outToolText.push(entry.name + entry.argsBuf) // tool 参数也是真实计费面
    yield { type: 'tool', id: entry.id || `call_${acc.fallbackToolSeq++}`, name: entry.name, input }
  }
  acc.toolAccum.clear()
}

/** tool arguments 解析：空串 = 无参调用 {}；非法 JSON 包 _raw。 */
function parseToolArgs(argsBuf: string): unknown {
  if (!argsBuf) return {}
  try {
    return JSON.parse(argsBuf)
  } catch {
    return { _raw: argsBuf }
  }
}

/** 在途未消费的 tool 分片（name+argsBuf）——估计入账面计入产出。 */
function pendingToolTextOf(acc: StreamAcc): string[] {
  return [...acc.toolAccum.values()].map((a) => a.name + a.argsBuf)
}

/** 异常/收尾时点用量：末见 usage 优先（网关实测值），否则按累计产出折算（与截断分支同源公式）。 */
function attemptUsageNow(acc: StreamAcc, fin: StreamFinalizer, req: GenRequest, model: string | undefined): TokenUsage {
  if (acc.latestUsage) return toUsage(acc.latestUsage)
  return fin.estimateUsage({
    req,
    model,
    outText: acc.outText,
    outToolText: acc.outToolText,
    pendingToolText: pendingToolTextOf(acc),
  })
}

/**
 * 流末收尾（chunk 循环之后；本函数返回即本次 stream 结束）：
 * - 见过 finish_reason 且拿到真实 usage → 过滤/拒答先判 error，否则 done；
 * - 见过 finish_reason 但网关不回 usage（include_usage 不兼容面）→ 残留 tool 事件补发并
 *   计入产出，按可得信号估计入账（estimated 标记）——放行生成，不判错重试；
 * - 未见过 finish_reason → 无终止事件的流结束 = 传输截断（可重试），真实消耗随错上抛
 *  （已见 usage 用实测，未见则估计；在途 tool 计入估计但不 flush 事件——gen 层遇 error 必弃事件）。
 */
function* settleStream(
  acc: StreamAcc,
  fin: StreamFinalizer,
  req: GenRequest,
  model: string | undefined,
  pendingStopReason: StopReason,
  sawFinishReason: boolean,
): Generator<GenEvent, void, void> {
  if (isRealUsage(acc.latestUsage) && sawFinishReason) {
    const usage = toUsage(acc.latestUsage)
    const filtered = fin.filterError(usage, pendingStopReason)
    if (filtered) {
      yield filtered
      return
    }
    const ev = fin.done(usage, pendingStopReason)
    if (ev) yield ev
  }
  if (fin.doneEmitted()) return

  if (!sawFinishReason) {
    yield fin.truncatedError(attemptUsageNow(acc, fin, req, model))
    return
  }

  yield* drainToolCalls(acc)
  const usage = fin.estimateUsage({ req, model, outText: acc.outText, outToolText: acc.outToolText })
  // 无 usage 的 content_filter 同款判错（估计 usage 随错上抛）
  const filtered = fin.filterError(usage, pendingStopReason)
  if (filtered) {
    yield filtered
    return
  }
  const ev = fin.done(usage, pendingStopReason)
  if (ev) yield ev
}

/**
 * OpenAI Chat Completions 适配器（/v1/chat/completions）。
 *
 * 线格式由 UI 的 Protocol 值决定（openai = Chat Completions），不靠 model 名自动猜测。
 *（openai-responses 协议线由 responses-adapter.ts 独立承载，经 registry 路由。）
 * 参数差异由 model-quirks 表驱动（方案 §4.1）。
 *
 * 不设「兼容导出」薄壳：两个导出同名同义（Provider / ProviderChat）会让调用方无法从
 * 名字判断该用哪个，且薄壳易丢 store/userDataPath 形参——名字收成唯一一个。
 */
export function createOpenAIProviderChat(
  conf: ProviderConf,
  client?: OpenAI,
  store?: ProviderStore,
  userDataPath?: string,
): ModelProvider {
  const c = client ?? createClient(conf)
  const q = quirksFor(conf.model ?? '')

  return {
    conf,

    async *stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> {
      let degraded = false // 成功建流是否用了降级参数面（fin.isDegraded 闭包读）
      // 本值恒为归一枚举成员——非标网关的未知 finish_reason 在捕获点即
      // 由 normalizeStopReason 归 'unknown' 并留痕；初值 'stop' 只在 sawFinishReason 之前
      // 有效，而 done 只在 sawFinishReason 之后发射（见下方收尾分支），故等价于「恒已赋值」
      let pendingStopReason: StopReason = 'stop' // finish_reason 先到但 usage 在后续 chunk → 延迟发 done
      let sawFinishReason = false // 流结束兜底区分：见过=完成但网关不发 usage；没见过=传输截断
      // 异常时点用量估计器——toolAccum /
      // latestUsage / outText 三件均声明在 attempt 循环内，外层 catch 取不到；由循环内逐
      // attempt 绑定（每次 attempt 起始重置，防上一 attempt 的半截累计泄入），catch 侧按
      // consumedAny 决定是否消费（未消费 = 建连期异常无消耗，不得估计虚报）
      let errorUsageOf: (() => TokenUsage) | undefined
      // 流级「是否曾开始消费」——外层 catch 的 usage 上抛门（循环内
      // 同名 per-attempt 变量每轮重置判降级续跑，本变量只置位不复位）
      let streamConsumedAny = false
      // resolve 后终值随 done 透出（降级链 attempt 不改 maxTokens；
      // openai 线无兜底不发 → undefined，与 toParams 上线值同源）
      const resolvedMaxTokens = req.maxTokens ?? modelConfOf(conf)?.maxTokens
      // done 发射 / 过滤判错 / 截断估算 / usage 兜底收口单点（三线共用，
      // 见 stream-finalize.ts）；本线不设 missingStopReason——done 只在 sawFinishReason
      // 之后发射，该分支 pendingStopReason 恒已由 finish_reason 赋值
      const fin = createStreamFinalizer({
        line: 'openai',
        stopField: 'finish_reason',
        resolvedMaxTokens,
        isDegraded: () => degraded,
      })

      // 400 降级链（方案 §6.5）：attempts 构造 / 400 续跑闸 / 记忆写入走 adapter-errors
      // 公共实现——「连接期异常（未 yield）可安全重试、流中异常不重跑」的约定见其注释。
      // 携来源 userDataPath——降级记忆读/写按显式 path 分发
      const plan = buildDegradeAttempts(req, q.structuredMode, conf, store, userDataPath)

      try {
        yield* runDegradeAttempts(
          plan,
          OpenAI.APIError,
          async function* (attempt, actx) {
            const stream = await c.chat.completions.create(toParams(conf, attempt), { signal })
            markStructuredDegrade(plan, attempt, store)
            // 成功建流用的是非首发（降级）参数面 → done 事件带 degraded
            // 判据并入降级记忆命中——基准改 plan.original（记忆命中时
            // attempts[0] 已是剥除版，旧判据对首发恒 false，记忆命中路径漏标 degraded）
            degraded = attempt !== plan.original
            // 本 attempt 的流内累计与异常用量估计器绑定（见流级声明处注释）——累计面
            // 每次 attempt 新建，防上一 attempt 半截累计泄入
            const acc = createStreamAcc()
            errorUsageOf = () => attemptUsageNow(acc, fin, req, conf.model ?? undefined)
            for await (const chunk of stream) {
              actx.consumed()
              streamConsumedAny = true // 跨 attempt 置位不复位
              // 消费流（usage 落账 / text / reasoning / tool_calls 增量）；终止值在捕获点即
              // 归一（'length'→'max_tokens'、'tool_calls'→'tool_use'；非标拼写归 'unknown'
              // 并留痕）——三线同一值域，收尾分支只按归一枚举判定
              const finishReason = yield* consumeChunk(chunk, acc)
              if (finishReason) {
                pendingStopReason = normalizeStopReason(finishReason, 'openai')
                sawFinishReason = true
              }
            }
            // 流末统一收尾（done 取最后可见 usage，末见 wins；过滤判错 / 缺 usage 估计 /
            // 无终止事件的传输截断三分支与判据口径见 settleStream 头注）
            yield* settleStream(acc, fin, req, conf.model ?? undefined, pendingStopReason, sawFinishReason)
          },
          'openai stream: 无可用参数面',
        )
      } catch (e) {
        // 流中 SDK 直接 throw（mid-stream 连接重置等）——估计用量随错上抛，
        // 否则消费中已见的 usage chunk 与累计产出随异常蒸发，runner 终态失败按 0 入账
        // （真实计费漏记）。已消费过流才上抛估计（未消费 = 建连期异常，无消耗不虚报；
        // 与「消费后不重跑」同源判据）。
        yield toErrorEvent(e, streamConsumedAny ? errorUsageOf?.() : undefined)
      }
    },
  }
}
