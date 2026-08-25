/**
 * 核心生成函数（方案 §四② 编排层基础）。
 *
 * 封装 provider.stream() 调用：收集 text 增量 + tool_use 结构化产出 + token 计量。
 * 上层编排（self-heal/review/analysis）在此之上构建重试 / 中断 / 进度 / 落盘逻辑。
 *
 * 中断：signal.abort() → provider 迭代器停止；SDK 内部 abort 请求。
 */
import type {
  ModelProvider,
  GenRequest,
  GenEvent,
  TokenUsage,
  GenErrorCode,
} from './provider/types.js'
import { quirksFor, responsesQuirksFor } from './provider/model-quirks.js'

/** 生成错误（A5：结构化字段与 GenEvent.error 对齐；code 供 failureAction 决策表分流） */
export class GenError extends Error {
  retryable: boolean
  code?: GenErrorCode
  status?: number
  retryAfterMs?: number
  requestId?: string
  /** B-12（第六十轮）：失败时网关已返回的 token 用量（如 max_tokens 截断）——runner
   *  终态失败路径按可得值入账（此前失败恒记 0，成本口径低估；多数失败响应无 usage，
   *  不携带即 undefined，行为不变） */
  usage?: TokenUsage
  constructor(
    message: string,
    retryable: boolean,
    fields?: { code?: GenErrorCode; status?: number; retryAfterMs?: number; requestId?: string; usage?: TokenUsage },
  ) {
    super(message)
    this.name = 'GenError'
    this.retryable = retryable
    if (fields?.code !== undefined) this.code = fields.code
    if (fields?.status !== undefined) this.status = fields.status
    if (fields?.retryAfterMs !== undefined) this.retryAfterMs = fields.retryAfterMs
    if (fields?.requestId !== undefined) this.requestId = fields.requestId
    if (fields?.usage !== undefined) this.usage = fields.usage
  }
}

/** 生成结果 */
export interface GenResult {
  /** 纯文本产出（tool_use 模式下可能为空） */
  text: string
  /** 思维链产出（DeepSeek/Kimi 思考模型的 reasoning_content，方案 §4.2） */
  reasoning: string
  /** tool_use 调用（结构化产出） */
  toolCalls: { id: string; name: string; input: unknown }[]
  usage: TokenUsage
  stopReason: string
  /** Q-13（第十五轮）：适配器 resolve 后实际上线的输出上限（done 事件透出；无兜底不发
   *  的 openai/responses 线为 undefined）——编排层透传落 llm/call（铁律②重放口径） */
  resolvedMaxTokens?: number
  /** 加密推理项（Responses 线缺口 11：reasoning_item 事件收集，chat.ts 组装回传用） */
  reasoningEncrypted?: string
  reasoningItemId?: string
  /** Z-12（第五十八轮）：成功建流用的是降级参数面（done 事件透出）——落 llm/call 供重放 */
  degraded?: boolean
}

/** B-2：chunk 超时默认值——每个事件前若超过此时限无数据，抛可重试 GenError。
 *  P3-1：参数化（环境变量 CLWRITING_FIRST_BYTE_TIMEOUT_MS，默认 60s 不变）——
 *  深度推理模型首 token 可能超过 60s，此前写死导致被误判 TIMEOUT 白废一轮请求 + 吃退避。 */
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 60_000
const FIRST_BYTE_TIMEOUT_ENV = 'CLWRITING_FIRST_BYTE_TIMEOUT_MS'

/** 显式 resolve 首字节超时（默认值纪律：链路参数不允许隐式默认穿透，超时也须可重放） */
export function resolveFirstByteTimeoutMs(): number {
  const raw = process.env[FIRST_BYTE_TIMEOUT_ENV]
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_FIRST_BYTE_TIMEOUT_MS
}

/**
 * 包装 async iterable，对每个 chunk 加超时（B-2：首字节网络挂起 → 快速失败可重试；
 * P3-8：流中途挂起同样超时，防 provider 发部分数据后静默卡死靠 runner 10min 兜底）。
 *
 * RB-AI-P2-3：新增 onStall 钩子——超时/异常先回调（调用方借此 abort 底层 HTTP），
 * 再做迭代器清理；仅放弃消费不 abort 时，重试期间旧请求继续在途生成计费。
 */
export async function* withFirstByteTimeout(
  source: AsyncIterable<GenEvent>,
  timeoutMs: number,
  onStall?: () => void,
): AsyncGenerator<GenEvent> {
  const it = source[Symbol.asyncIterator]()
  while (true) {
    const next = it.next()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new GenError(`响应超时（${timeoutMs / 1000}s 无数据），服务可能不可达`, true, { code: 'TIMEOUT' })),
        timeoutMs,
      )
    })
    try {
      const result = await Promise.race([next, timeout])
      if (result.done) { await it.return?.(); return }
      yield result.value
    } catch (e) {
      // P1-1：超时/异常 → 关闭上游迭代器释放 HTTP 连接（否则悬挂连接叠加重试最多 4 条并存）。
      // Q2：不得 `await it.return?.()` —— async generator 的 return() 会排队等待挂起的 next()
      // 结算；半死连接场景下 next() 永不结算 → 60s 快速失败退化 10min 死等。
      // 改为不等待（连接短暂驻留，由外层 signal 最终清理）。
      // RB-AI-P2-3：先 onStall（abort signal，SDK 立即断开在途 HTTP）再清理迭代器——
      // 只放弃消费不 abort 时旧请求仍服务端继续生成计费
      // M-3（第八轮）：return() 触发的清理段（内层 SDK 流隐式 return）reject 时若被
      // void 丢弃即 unhandledRejection 崩主进程（第六轮 stream.ts:186 同型收敛）——
      // 吞清理段异常，外层 e 照常上抛走重试链
      onStall?.()
      it.return?.().catch(() => { /* 清理段异常不外抛 */ })
      throw e
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/**
 * 跑一次 provider 生成，收集全部事件。
 *
 * @param onText 文本增量回调（SSE 逐字转发前端用）
 * @throws GenError 不可重试的错误；可重试的错误也抛 GenError（retryable=true 供上层判定）
 */
export async function generate(
  provider: ModelProvider,
  req: GenRequest,
  signal: AbortSignal,
  onText?: (delta: string) => void,
): Promise<GenResult> {
  // #6（表驱动重构）：模型不支持工具调用（chat 路径直调 generate）→ 剥掉 tools，
  // 防不支持工具的模型收到 tools 数组 → 400 或静默忽略（学 canModelConsumeTools）
  // Responses 启用批 R2a 缺口 5：意图翻译按协议视图查表，requireTool 在 responses 线不再静默丢弃
  const q = provider.conf.protocol === 'openai-responses' ? responsesQuirksFor(provider.conf.model ?? '') : quirksFor(provider.conf.model ?? '')
  const effective: GenRequest = !q.toolUse && req.tools?.length ? { ...req, tools: undefined } : req
  let text = ''
  const reasoning: string[] = []
  // Responses 线缺口 11：加密推理项收集（reasoning_item 事件）——chat.ts 组装 reasoning 块入历史，
  // 下轮回传维持推理状态；多轮每回合独立 generate，取最后一个即可
  let reasoningEncrypted: string | undefined
  let reasoningItemId: string | undefined
  const toolCalls: { id: string; name: string; input: unknown }[] = []
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let stopReason = 'end_turn'
  let resolvedMaxTokens: number | undefined // Q-13：done 事件透出的上线输出上限
  let degraded = false // Z-12：成功建流是否用了降级参数面（done 事件透出）

  // RB-AI-P2-3：per-attempt abort——底层生成拿 attempt.signal（不再是外层 signal 本体）：
  // - 外层用户/编排 signal abort → 联动 attempt.abort()（行为不变：SDK 断开 + 「已中断」）；
  // - 首字节/chunk 超时 → onStall 先 attempt.abort()（终止在途 HTTP，服务端停止生成计费）
  //   再抛可重试 GenError 进上层重试——此前只放弃消费迭代器，旧请求最多 3 次重试期间并存 4 条在途
  const attempt = new AbortController()
  const onOuterAbort = (): void => attempt.abort()
  if (signal.aborted) attempt.abort()
  else signal.addEventListener('abort', onOuterAbort)
  try {
    for await (const ev of withFirstByteTimeout(
      provider.stream(effective, attempt.signal),
      resolveFirstByteTimeoutMs(),
      () => attempt.abort(),
    )) {
      switch (ev.type) {
        case 'text':
          text += ev.delta
          onText?.(ev.delta)
          break
        case 'reasoning':
          reasoning.push(ev.delta)
          break
        case 'reasoning_item':
          // Responses 线缺口 11：覆盖式取最后一个（一回合一条加密推理项）
          reasoningEncrypted = ev.encrypted
          reasoningItemId = ev.itemId
          break
        case 'tool':
          toolCalls.push({ id: ev.id, name: ev.name, input: ev.input })
          break
        case 'done':
          usage = ev.usage
          stopReason = ev.stopReason
          if (ev.resolvedMaxTokens !== undefined) resolvedMaxTokens = ev.resolvedMaxTokens
          if (ev.degraded) degraded = true
          break
        case 'error':
          throw new GenError(ev.message, ev.retryable, {
            code: ev.code,
            status: ev.status,
            retryAfterMs: ev.retryAfterMs,
            requestId: ev.requestId,
          })
      }
    }
  } finally {
    signal.removeEventListener('abort', onOuterAbort)
  }

  return { text, reasoning: reasoning.join(''), toolCalls, usage, stopReason, resolvedMaxTokens, reasoningEncrypted, reasoningItemId, ...(degraded ? { degraded: true } : {}) }
}

/**
 * 简化版：只取纯文本产出（无 tool_use 场景，如 outline）。
 * 等价于 generate() 后取 .text。
 */
export async function generateText(
  provider: ModelProvider,
  req: GenRequest,
  signal: AbortSignal,
  onText?: (delta: string) => void,
): Promise<string> {
  const r = await generate(provider, req, signal, onText)
  // P1-3：纯文本端点截断检查（与 generateTool 对称）
  if (r.stopReason === 'max_tokens') {
    // R61-6（第六十一轮）：截断调用照样烧 token，usage 随错误上抛记账（此前截断即丢账）
    throw new GenError('AI 产出达到长度上限被截断，请精简输入提示或稍后重试。', false, { code: 'MAX_TOKENS', usage: r.usage })
  }
  return r.text
}

/**
 * 简化版：只取 tool_use 结构化产出（写作/分析/审稿场景）。
 * 返回第一个 tool 调用的 input；无 tool 调用时回退到 text（降级路径）。
 */
export async function generateTool(
  provider: ModelProvider,
  req: GenRequest,
  signal: AbortSignal,
  onText?: (delta: string) => void,
): Promise<{ input: unknown; text: string; usage: TokenUsage; stopReason: string; resolvedMaxTokens?: number; degraded?: boolean }> {
  // 表驱动重构 §5.3：能力判据从 modelCaps 探测换成静态表（#1 根治）
  // Responses 启用批 R2a 缺口 5：意图翻译按协议视图查表，requireTool 在 responses 线不再静默丢弃
  const q = provider.conf.protocol === 'openai-responses' ? responsesQuirksFor(provider.conf.model ?? '') : quirksFor(provider.conf.model ?? '')
  // P0-2：模型不支持工具调用 → 提前拒绝（避免进入生成阶段拿不到 tool_use 再降级失败浪费 token）
  if (!q.toolUse) {
    throw new GenError('该模型不支持工具调用（tool_use），不能用于写作/审稿/分析。请在设置中更换支持工具调用的模型。', false, { code: 'UNSUPPORTED' })
  }
  // 意图翻译：requireTool=true 表示「必须产出工具调用」，按表 toolChoiceMode 落实际参数
  let effective: GenRequest = req
  if (req.requireTool && req.toolName) {
    if (q.toolChoiceMode === 'named') {
      // 可指名 → tool_choice 指名（保留 toolName 精确指向）
      effective = { ...req, toolChoice: 'tool', toolName: req.toolName }
    } else if (q.toolChoiceMode === 'required') {
      // 只能「必须调某个」不能点名（Kimi k3）→ 转 any（OpenAI required / Anthropic any）
      effective = { ...req, toolChoice: 'any' }
    } else {
      // auto/none（GLM / responses 协议）→ 不发 tool_choice，prompt 引导 + 契约层校验重试
      effective = { ...req, toolChoice: undefined, toolName: undefined }
    }
  }
  // 调用方未指定 toolChoice 且模型可强制 → 强制（确保结构化产出）；auto/none 不强制
  if (!effective.toolChoice && (q.toolChoiceMode === 'named' || q.toolChoiceMode === 'required')) {
    effective = { ...effective, toolChoice: 'any' }
  }
  const r = await generate(provider, effective, signal, onText)
  const tool = r.toolCalls[0]
  // P1-3：输出撞顶且无 tool_use → JSON 被截断；抛明确错误而非静默降级到 text
  if (!tool && r.stopReason === 'max_tokens') {
    // R61-6（第六十一轮）：同 generateText——截断调用 usage 随错误上抛记账
    throw new GenError('AI 产出达到长度上限被截断，结构化结果不完整，请精简输入提示或稍后重试。', false, { code: 'MAX_TOKENS', usage: r.usage })
  }
  return {
    input: tool ? tool.input : null,
    text: r.text,
    usage: r.usage,
    stopReason: r.stopReason,
    // Q-13：透传给编排层（spec.run 回调聚合进 runTask 结果 → llm/call）
    resolvedMaxTokens: r.resolvedMaxTokens,
    ...(r.degraded ? { degraded: true } : {}),
  }
}
