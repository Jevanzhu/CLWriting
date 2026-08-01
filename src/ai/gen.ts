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
  toolCalls: { name: string; input: unknown }[]
  usage: TokenUsage
  stopReason: string
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
  const toolCalls: { name: string; input: unknown }[] = []
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let stopReason = 'end_turn'

  for await (const ev of provider.stream(req, signal)) {
    switch (ev.type) {
      case 'text':
        text += ev.delta
        onText?.(ev.delta)
        break
      case 'tool':
        toolCalls.push({ name: ev.name, input: ev.input })
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
): Promise<{ input: unknown; text: string; usage: TokenUsage }> {
  const r = await generate(provider, req, signal, onText)
  const tool = r.toolCalls[0]
  return {
    input: tool ? tool.input : null,
    text: r.text,
    usage: r.usage,
  }
}
