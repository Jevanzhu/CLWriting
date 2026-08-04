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
} from './provider/types.js'

/** 生成错误 */
export class GenError extends Error {
  retryable: boolean
  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'GenError'
    this.retryable = retryable
  }
}

/** 生成结果 */
export interface GenResult {
  /** 纯文本产出（tool_use 模式下可能为空） */
  text: string
  /** tool_use 调用（结构化产出） */
  toolCalls: { id: string; name: string; input: unknown }[]
  usage: TokenUsage
  stopReason: string
}

/** B-2：首字节超时——首个事件前若超过此时限无响应，抛可重试 GenError */
const FIRST_BYTE_TIMEOUT_MS = 60_000

/** 包装 async iterable，在首个事件前加超时（B-2：网络挂起 → 快速失败可重试） */
export async function* withFirstByteTimeout(
  source: AsyncIterable<GenEvent>,
  timeoutMs: number,
): AsyncGenerator<GenEvent> {
  const it = source[Symbol.asyncIterator]()
  let firstByteReceived = false
  while (true) {
    const next = it.next()
    if (!firstByteReceived) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<IteratorResult<GenEvent>>((_, reject) => {
        timer = setTimeout(
          () => reject(new GenError(`首字节超时（${timeoutMs / 1000}s 无响应），服务可能不可达`, true)),
          timeoutMs,
        )
      })
      try {
        const result = await Promise.race([next, timeout])
        if (result.done) { await it.return?.(); return }
        firstByteReceived = true
        yield result.value
      } catch (e) {
        // P1-1：超时/异常 → 关闭上游迭代器释放 HTTP 连接（否则悬挂连接叠加重试最多 4 条并存）
        await it.return?.()
        throw e
      } finally {
        if (timer) clearTimeout(timer)
      }
    } else {
      const result = await next
      if (result.done) return
      yield result.value
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
  let text = ''
  const toolCalls: { id: string; name: string; input: unknown }[] = []
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let stopReason = 'end_turn'

  for await (const ev of withFirstByteTimeout(provider.stream(req, signal), FIRST_BYTE_TIMEOUT_MS)) {
    switch (ev.type) {
      case 'text':
        text += ev.delta
        onText?.(ev.delta)
        break
      case 'tool':
        toolCalls.push({ id: ev.id, name: ev.name, input: ev.input })
        break
      case 'done':
        usage = ev.usage
        stopReason = ev.stopReason
        break
      case 'error':
        throw new GenError(ev.message, ev.retryable)
    }
  }

  return { text, toolCalls, usage, stopReason }
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
    throw new GenError('AI 产出达到长度上限被截断，请精简输入提示或稍后重试。', false)
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
): Promise<{ input: unknown; text: string; usage: TokenUsage; stopReason: string }> {
  // P0-2：模型不支持工具调用 → 提前拒绝（避免进入生成阶段拿不到 tool_use 再降级失败浪费 token）
  if (provider.modelCaps?.toolUse === false) {
    throw new GenError('该模型不支持工具调用（tool_use），不能用于写作/审稿/分析。请在设置中更换支持工具调用的模型。', false)
  }
  // 模型级 caps.toolChoice=true → 强制工具调用（确保结构化产出）；null/false 则依赖 prompt 引导 + text 兜底
  // 强制工具调用仅在调用方未指定 toolChoice 时生效（保留调用方的 toolName 精确指向）
  const effective = provider.modelCaps?.toolChoice && !req.toolChoice
    ? { ...req, toolChoice: 'any' as const }
    : req
  const r = await generate(provider, effective, signal, onText)
  const tool = r.toolCalls[0]
  // P1-3：输出撞顶且无 tool_use → JSON 被截断；抛明确错误而非静默降级到 text
  if (!tool && r.stopReason === 'max_tokens') {
    throw new GenError('AI 产出达到长度上限被截断，结构化结果不完整，请精简输入提示或稍后重试。', false)
  }
  return {
    input: tool ? tool.input : null,
    text: r.text,
    usage: r.usage,
    stopReason: r.stopReason,
  }
}
