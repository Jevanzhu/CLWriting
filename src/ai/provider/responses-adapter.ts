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
  EffortLevel,
} from './types.js'
import type { ProviderStore } from './store.js'
import { modelConfOf } from './store.js'
import { responsesQuirksFor } from './model-quirks.js'
import { resolveToolChoiceIntent } from './tool-choice.js' // R0912-D-P3-3：tool_choice 分档决策单源
import { makeToErrorEvent, buildDegradeAttempts, isMidChain400, markStructuredDegrade } from './adapter-errors.js'
import { createStreamFinalizer } from './stream-finalize.js'
// R0916-7-P3-2：流事件的语义单元（增量/工具累积/终态判决/流尾）——本文件只留骨架
//（建流 → 逐事件交判定 → 逐条 yield → 400 降级链），单事件语义与顺序不变量见该件头注
import {
  createResponsesStreamAccum,
  applyResponsesStreamEvent,
  closeStreamAttempt,
  estimateAttemptUsage,
  type StreamEventCtx,
} from './responses-stream.js'
import { log } from '../../log/index.js'

/** SDK 异常 → GenEvent.error：公共工厂实现（adapter-errors），此处只贴本线错误类与 label */
const toErrorEvent = makeToErrorEvent({
  APIError: OpenAI.APIError,
  APIUserAbortError: OpenAI.APIUserAbortError,
  APIConnectionError: OpenAI.APIConnectionError,
  label: 'OpenAI API',
})

/** tool_use 往返：user 的 tool_result → function_call_output 输出项（call_id 关联） */
function toolOutputItem(toolUseId: string, content: string): OpenAI.Responses.ResponseInputItem.FunctionCallOutput {
  return { type: 'function_call_output', call_id: toolUseId, output: content }
}

/**
 * R0916-7-P3-16：本线工具项——SDK 的 FunctionTool 把 strict 声明为必填，本线沿用既有
 * 线格式有意不发（补该字段 = 改请求体形状，违反行为逐位不变）；用交叉类型把该字段改回
 * 可选，逐字段表达差异，不再整对象双重断言。
 */
type ResponsesWireTool = Omit<OpenAI.Responses.FunctionTool, 'strict'> & { strict?: boolean | null }

/**
 * R0916-7-P3-16：本线参数类型 = SDK 类型 + 逐项声明的线格式差异：
 * - tools：SDK 必填 strict 被本线有意省略（见 ResponsesWireTool）；
 * - reasoning_effort / output_config：非 SDK 字段（grok 顶层 reasoning_effort、deepseek
 *   output_config，落点由 responsesWire.effortWire 表驱动）。
 * 其余字段（model/input/stream/store/max_output_tokens/reasoning/text/include/tool_choice/
 * parallel_tool_calls）全部按 SDK 类型构造并受其校验。
 */
type ResponsesParams = Omit<OpenAI.Responses.ResponseCreateParamsStreaming, 'tools'> & {
  tools?: ResponsesWireTool[]
  reasoning_effort?: EffortLevel
  output_config?: { effort?: EffortLevel }
}

/**
 * R0916-7-P3-16：白名单转换点（本文件唯一一处窄断言）——SDK 的 tools 元素要求 strict
 * 必填而本线有意不发，ResponsesWireTool 与 SDK Tool 的差异仅此一项（其余字段是 SDK
 * 类型的直接产物）；按已知差异定向转换，形状漂移仍由 toParams 内的赋值受 tsc 拦下。
 * （导出供测试做类型层可赋性断言：转换后即 SDK create 的入参类型。）
 */
export function asSdkParams(p: ResponsesParams): OpenAI.Responses.ResponseCreateParamsStreaming {
  return p as OpenAI.Responses.ResponseCreateParamsStreaming
}

/**
 * GenRequest → /v1/responses 请求体（R2b：全量翻译走 responsesQuirksFor 视图）。
 *
 * 网关偏差挂点（缺口 18，初版不建改写框架）：某网关 400 或缺字段时，按 cherry ark.ts
 * 模式（请求剥 include / 响应补 annotations）在此尾部加 per-family patch。
 */
export function toParams(conf: ProviderConf, req: GenRequest): ResponsesParams {
  const q = responsesQuirksFor(conf.model ?? '')
  const rw = q.responsesWire

  const input: OpenAI.Responses.ResponseInputItem[] = []
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
    const toolUseItems: OpenAI.Responses.ResponseInputItem[] = []
    // R72-12（二十轮 A-3）：user 分支与 assistant 同构——tool_result 也收集后统一输出，
    // 消除「text+tool_result 混排 user 消息」的块序颠倒（当前链路 tool_result 独占
    // user 消息不触发，防御性对齐）
    const toolResultItems: OpenAI.Responses.ResponseInputItem[] = []
    // R3（缺口 11）：assistant 轮 reasoning 块按 echoReasoning 分档——encrypted 回插
    // 加密推理项（置于该 assistant 的 text/function_call 之前，Responses 语义：reasoning
    // item 先于其产出的 function_call）；strip/none 跳过（grok CLI 代理拒绝回传 / 未测）。
    const reasoningItems: OpenAI.Responses.ResponseInputItem[] = []
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
        toolResultItems.push(toolOutputItem(b.toolUseId, b.content))
      }
    }
    if (m.role === 'assistant') {
      input.push(...reasoningItems)
      if (textParts.length > 0) input.push({ role: 'assistant', content: textParts.join('') })
      input.push(...toolUseItems)
    } else {
      // R51-C-2（五十一轮）：function_call_output 先出、text 后出，与 openai 线
      // R31-6 块序对齐——Responses 语义 function_call_output 须紧跟其 function_call
      //（跨轮历史里 assistant 的 function_call 在前，中间插 user text 会拆散关联对，
      // 严格网关 400）。当前链路 tool_result 恒独占 user 消息不触发（R72-12 同注），
      // 本序修正是防御性口径对齐，两线不再相反。
      input.push(...toolResultItems)
      if (textParts.length > 0) input.push({ role: 'user', content: textParts.join('') })
    }
  }

  const params: ResponsesParams = {
    // B-P2-6：conf.model 可能为 null/undefined（未选模型时），兜底空串防 SDK 报参数错
    model: conf.model ?? '',
    input,
    stream: true,
    // 缺口 9：OpenAI 默认 store=true（响应留存 30 天）——书稿全文上行场景必须显式 false
    //（cherry openai 线无条件 store:false 印证）；DeepSeek 恒 false 天然兼容、grok 无状态。
    store: false,
  }
  // 阶段 14 §7.2：调用方显式 cap（req.maxTokens）优先；其次用户模型行覆盖；仍无 → 不发（同 OpenAI 线行为）
  const tokenCap = req.maxTokens ?? modelConfOf(conf)?.maxTokens
  if (tokenCap) params['max_output_tokens'] = tokenCap

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
  // {type:'function',name}，非 Chat 的 {type, function:{name}}）——分档决策单源见
  // tool-choice.ts（R0912-D-P3-3 三适配器同构 if 树收敛；rw.toolChoiceMode 视图无
  // 'none' 档），此处只留动作 → wire 值发射：force → 'required'、force-named → 扁平
  // {type:'function',name}、auto → 'auto'，none → 不发（prompt 引导 + 契约层校验重试兜底）。
  if (req.toolChoice) {
    const intent = resolveToolChoiceIntent({ toolChoiceMode: rw.toolChoiceMode, toolChoice: req.toolChoice, toolName: req.toolName })
    if (intent.action === 'force') params['tool_choice'] = 'required'
    else if (intent.action === 'force-named') params['tool_choice'] = { type: 'function', name: intent.name }
    else if (intent.action === 'auto') params['tool_choice'] = 'auto'
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

function toResponsesTool(tool: ToolDef): ResponsesWireTool {
  // 全库重评-0914 P3-1：description 缺省改条件省略——原 `?? ''` 对缺省 description 发
  // 空串，与 anthropic-adapter / openai-adapter 两线的条件 omit 行为分叉（空串 description
  // 与缺省字段在严格端点语义不同）；三线行为分叉收编为同一条件 omit 口径
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.input_schema,
  }
}

export function createOpenAIResponsesProvider(
  conf: ProviderConf,
  client?: OpenAI,
  store?: ProviderStore,
  userDataPath?: string,
): ModelProvider {
  // R31-5（三十一轮）：SDK 内建重试关闭（runner 重试层是唯一重试决策方，见 openai-adapter 同注）
  const c = client ?? new OpenAI({ apiKey: conf.apiKey, baseURL: normalizeBaseUrl(conf.baseUrl), maxRetries: 0 })
  const q = responsesQuirksFor(conf.model ?? '')

  return {
    conf,

    async *stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> {
      let degraded = false // Z-12：成功建流是否用了降级参数面（fin.isDegraded 闭包读）
      // R0917-6-P3-4（2026-09-17 全库源码重评六轮修复批）：异常时点用量估计器——toolAccum /
      // outText / outToolText / terminal 均在 attempt 循环内（累积态见 responses-stream），
      // 外层 catch 取不到；由循环内逐 attempt 绑定（每次 attempt 起始重置，防上一 attempt
      // 的半截累计泄入）
      let errorUsageOf: (() => TokenUsage) | undefined
      // R0917-6-P3-4：流级「是否曾开始消费」——外层 catch 的 usage 上抛门（循环内同名
      // per-attempt 变量每轮重置判降级续跑，本变量只置位不复位）
      let streamConsumedAny = false
      // Q-13（第十五轮）：resolve 后终值随 done 透出（与 toParams 的 tokenCap 同链：
      // 调用方 cap → 模型行；无兜底不发 → undefined）
      const resolvedMaxTokens = req.maxTokens ?? modelConfOf(conf)?.maxTokens
      // R0916-7-P3-15：done 发射 / 估计兜底 / 终态错误壳 / 截断收口单点（三线共用，
      // 见 stream-finalize.ts）。本线终止值由终止事件类型判定（非读线上拼写）故产出恒为
      // 归一枚举成员；stopField 仅占位（本线的「非 max 不完整」走 terminalError 专属文案）
      const fin = createStreamFinalizer({
        line: 'responses',
        stopField: 'incomplete_details.reason',
        resolvedMaxTokens,
        isDegraded: () => degraded,
      })
      // R0916-7-P3-2：事件判定的外部依赖——本线骨架只做「建流 → 逐事件交判定 → 逐条 yield」，
      // 单事件语义（增量/累积/终态）在 responses-stream。req 恒传**首发请求**：usage 估计的
      // input 折算基准，降级 attempt 的请求不参与折算（口径与原实现一致）
      const ctx: StreamEventCtx = { fin, req, model: conf.model ?? undefined }

      // 400 降级链（缺口 14）：structured → tools 两级剥除；attempts 构造 / 400 续跑闸 /
      // 记忆写入走 adapter-errors 公共实现（「连接期可安全重试、流中不重跑」约定见其注释）。
      // 判据 q.structuredMode 是 responsesQuirksFor 的 responsesWire 覆盖值（与 text.format
      // 发射同源）；mode='json_object' 时 text.format 不发但链仍保留（照搬原实现口径）。
      // R30-4（三十轮）：携来源 userDataPath——降级记忆读/写按显式 path 分发
      const plan = buildDegradeAttempts(req, q.structuredMode, conf, store, userDataPath)

      try {
        let lastErr: unknown = null
        for (const attempt of plan.attempts) {
          // ii-1：本 attempt 是否已开始消费流。降级续跑只对「建连期 400」安全——
          // 已收到事件后换参数面重跑会让消费者收到重复增量，一律转终态错误。
          let consumedAny = false
          try {
            const stream = await c.responses.create(asSdkParams(toParams(conf, attempt)), { signal })
            markStructuredDegrade(plan, attempt, store)
            // Z-12（第五十八轮）：成功建流用的是非首发（降级）参数面 → done 事件带 degraded
            // A3（五十九轮）：判据并入降级记忆命中——基准改 plan.original（记忆命中时
            // attempts[0] 已是剥除版，旧判据对首发恒 false，记忆命中路径漏标 degraded）
            degraded = attempt !== plan.original

            // 本 attempt 的流消费状态（分块拼装 / 产出累计 / 终止态），随 attempt 新建
            const accum = createResponsesStreamAccum()
            // R0917-6-P3-4：本 attempt 的异常用量估计器绑定——流中 SDK 直接 throw 时异常
            // 事件无 usage 载荷，走估计折算（与流中 error 事件分支同源口径，标 estimated）
            errorUsageOf = () => estimateAttemptUsage(accum, ctx)

            // ── R1 事件循环：终止事件契约 ──
            // 流必须以 completed / incomplete / failed 之一收尾；无终止事件 = 传输截断。
            // 单事件语义（含网关偏差挂点，缺口 18）见 responses-stream；本循环只保证
            // 「逐事件判定 → 按序 yield → stop 即 return」三步顺序不变。
            for await (const event of stream) {
              consumedAny = true
              streamConsumedAny = true // R0917-6-P3-4：跨 attempt 置位不复位
              const step = applyResponsesStreamEvent(accum, event, ctx)
              for (const ev of step.events) yield ev
              if (step.stop) return
            }

            // 流尾收尾（R32-2/R48-30/R39-13）：截断壳在残留清理前估算，清理后按计数留痕
            const tail = closeStreamAttempt(accum, ctx)
            // A-5（二十九轮）：多条加密推理项 → 流尾一次性汇总留痕丢弃条数
            //（GenResult.reasoningEncrypted 覆盖式只留末条，前 N-1 条不再无感消失）
            if (tail.discardedReasoningItems > 0) {
              log.warn('responses', `单回合收到 ${accum.reasoningItemCount} 条加密推理项，GenResult 仅保留末条（丢弃 ${tail.discardedReasoningItems} 条，chat 回传推理状态以末条为准）`)
            }
            for (const ev of tail.events) yield ev
            return
          } catch (e) {
            if (!consumedAny && isMidChain400(e, OpenAI.APIError, attempt, plan)) {
              lastErr = e
              continue // 建连期 400 → 尝试下一个降级参数面（流已开始消费则不重跑，见 consumedAny 注释）
            }
            throw e
          }
        }
        throw lastErr ?? new Error('openai-responses stream: 无可用参数面')
      } catch (e) {
        // R0917-6-P3-4（2026-09-17 全库源码重评六轮修复批）：流中 SDK 直接 throw（mid-stream
        // 连接重置等）此前恒裸传——消费中累计的产出随异常蒸发，runner 终态失败按 0 入账。
        // 已消费过流才折算估计上抛（未消费 = 建连期异常无消耗不虚报；与 ii-1 同源判据）。
        yield toErrorEvent(e, streamConsumedAny ? errorUsageOf?.() : undefined)
      }
    },
  }
}


/** 归一化 baseUrl（方案 §4.5 P0）：只去尾部斜杠，不剥 /v1（openai SDK 不自拼 /v1）。 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

