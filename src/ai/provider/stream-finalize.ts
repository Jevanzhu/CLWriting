/**
 * R0916-7-P3-15（2026-09-24 全项目源码质量与优雅度评审 P3-15）：三适配器流尾收口单点。
 *
 * 收口面（原在 openai / anthropic / responses 三线各写 2–3 份逐字同款拷贝）：
 * - done 事件发射（幂等门 + resolvedMaxTokens / degraded 透传）；
 * - 截断估算 / usage 兜底（input 实测优先 → 请求字符折算；output 按累计产出折算）；
 * - 过滤 / 拒答（content_filter / refusal）→ error 出场，不发 done；
 * - 终态错误壳与传输截断错误壳（B-12：usage 随错上抛，runner 终态失败按真实消耗入账）；
 * - stopReason 归一（types.ts 判别联合 StopReason；线上未知拼写显式归类 'unknown' 并留痕）。
 *
 * 边界（有意不共用）：何时发 done、何时判传输截断的**判定**留在各适配器——它与各线流
 * 事件形态强耦合（openai sawFinishReason / anthropic pendingStopReason / responses
 * terminal 四态），抽走会把三线判定塞进一个开关堆里。本模块只承载「同一语义在三线的
 * 逐字同款产出」，与 adapter-errors.ts 的分工同构（那边收口 400 降级链与异常工厂）。
 */
import type { GenErrorCode, GenEvent, GenRequest, StopReason, TokenUsage } from './types.js'
import { estimateInputTokens, estimateOutputTokens } from './usage-estimate.js'
import { log } from '../../log/index.js'

/** 协议线标签（日志留痕归因用） */
export type WireLine = 'openai' | 'anthropic' | 'responses'

/** 本线终止字段名（过滤 / 拒答文案里的证据出处，一字不改既有文案） */
export type StopReasonField = 'finish_reason' | 'stop_reason' | 'incomplete_details.reason'

/** 归一联合的运行时值表（与 types.ts StopReason 逐值对应；新增成员须同步两处） */
const STOP_REASON_VALUES: readonly StopReason[] = [
  'end_turn',
  'stop',
  'max_tokens',
  'tool_use',
  'stop_sequence',
  'pause_turn',
  'refusal',
  'content_filter',
  'model_context_window_exceeded',
  'function_call',
  'unknown',
]

/** 值域收窄守卫（runner 侧对 run 回调返回值的 stopReason 同用此判定） */
export function isStopReason(v: string): v is StopReason {
  return (STOP_REASON_VALUES as readonly string[]).includes(v)
}

/** 各线原生终止拼写 → 归一值（未列出者须已在联合内，否则归 'unknown' 并留痕） */
const WIRE_ALIASES: Readonly<Record<WireLine, Readonly<Record<string, StopReason>>>> = {
  // Chat Completions：'length'/'tool_calls' 是协议对撞顶与工具收尾的拼写，归一为
  // 三线共用的 'max_tokens'/'tool_use'（对齐 Anthropic 命名，generateText 截断检查靠此）
  openai: { length: 'max_tokens', tool_calls: 'tool_use' },
  // Anthropic 原生值即归一值（SDK StopReason 七值，其中 refusal 由适配器判 error）
  anthropic: {},
  // responses 线不读线上终止拼写（由终止事件类型判定，产出值本就是归一值）
  responses: {},
}

/**
 * 线上终止值 → 归一判别值。非标网关自造拼写（如 'eos'/'STOP'）归 'unknown' 并留痕——
 * 既不静默丢弃，也不让任意字符串流进 done / llm/call 的重放口径。
 */
export function normalizeStopReason(raw: string, line: WireLine): StopReason {
  const aliased = WIRE_ALIASES[line][raw]
  if (aliased !== undefined) return aliased
  if (isStopReason(raw)) return raw
  log.warn('provider', JSON.stringify({ msg: 'stopReason 未知值（归类 unknown）', line, raw }))
  return 'unknown'
}

/** 估计用量输入（各线可得信号不一，缺省侧不估） */
export interface EstimateUsageSources {
  req: GenRequest
  model?: string
  /** 累计产出正文 / 推理 delta（R73-1/R74-1 计费面） */
  outText: readonly string[]
  /** 已消费的 tool 参数（name + args 串联） */
  outToolText: readonly string[]
  /** 在途未消费的 tool 分片（name + args 串联）——一并计入产出折算 */
  pendingToolText?: readonly string[]
  /** 实测输入 token（>0 时优先于字符折算，如 Anthropic message_start） */
  measuredInputTokens?: number
  /** 实测 cache 两档（Anthropic message_start；OpenAI 兼容线无此概念） */
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** 流尾收口配置 */
export interface StreamFinalizerOpts {
  /** 本线标签（留痕） */
  line: WireLine
  /** 本线终止字段名（过滤 / 拒答文案） */
  stopField: StopReasonField
  /** Q-13：resolve 后上线输出上限（done 透出；无兜底不发的线 undefined） */
  resolvedMaxTokens?: number
  /** Z-12：本次成功建流是否用了降级参数面（延迟读——建流后才确定） */
  isDegraded: () => boolean
  /**
   * 缺终止值时的协议默认（显式声明，不做隐式兜底）：Anthropic 线 message_delta 下发
   * usage 但不带 stop_reason 即「回合正常结束」→ 'end_turn'。OpenAI 线 done 只在
   * sawFinishReason 后发射（该分支 pendingStopReason 恒已赋值）故不设；未设且缺值时
   * 归 'unknown' 并留痕。
   */
  missingStopReason?: StopReason
}

/** 流尾收口单点（三适配器共用；实例生命周期 = 一次 stream() 调用） */
export interface StreamFinalizer {
  /** done 是否已发射（适配器兜底分支的判据） */
  doneEmitted(): boolean
  /** 归一 stopReason 后发 done（幂等：已发过返 null） */
  done(usage: TokenUsage, rawStopReason: string | null | undefined): GenEvent | null
  /** 过滤 / 拒答 → error（未命中返 null，调用方照常走 done） */
  filterError(usage: TokenUsage, rawStopReason: string | null | undefined): GenEvent | null
  /** 终态错误壳（retryable:false；code 省略 = 无结构化码） */
  terminalError(message: string, usage: TokenUsage, code?: GenErrorCode): GenEvent
  /** 传输截断（流结束无终止事件；可重试） */
  truncatedError(usage: TokenUsage): GenEvent
  /** 估计用量（input 实测优先 → 请求字符折算；output 按累计产出折算；estimated 标记） */
  estimateUsage(src: EstimateUsageSources): TokenUsage
}

export function createStreamFinalizer(opts: StreamFinalizerOpts): StreamFinalizer {
  let doneEmitted = false

  /** 终止值归一 + 缺值策略（site 只进留痕，不改判定） */
  const resolveStop = (raw: string | null | undefined, site: 'done' | 'filter'): StopReason => {
    if (raw === null || raw === undefined || raw === '') {
      if (opts.missingStopReason !== undefined) return opts.missingStopReason
      log.warn('provider', JSON.stringify({ msg: '缺终止值（归类 unknown）', line: opts.line, site }))
      return 'unknown'
    }
    return normalizeStopReason(raw, opts.line)
  }

  return {
    doneEmitted: () => doneEmitted,

    done(usage, rawStopReason) {
      if (doneEmitted) return null
      doneEmitted = true
      return {
        type: 'done',
        usage,
        stopReason: resolveStop(rawStopReason, 'done'),
        resolvedMaxTokens: opts.resolvedMaxTokens,
        ...(opts.isDegraded() ? { degraded: true } : {}),
      }
    },

    filterError(usage, rawStopReason) {
      const stop = resolveStop(rawStopReason, 'filter')
      if (stop !== 'content_filter' && stop !== 'refusal') return null
      return {
        type: 'error',
        message: `生成被内容过滤截断（${opts.stopField}=${stop}）——半截产出不落稿，请调整提示词后重试`,
        retryable: false,
        code: 'PROTOCOL',
        usage,
      }
    },

    terminalError(message, usage, code) {
      return { type: 'error', message, retryable: false, ...(code !== undefined ? { code } : {}), usage }
    },

    truncatedError(usage) {
      return { type: 'error', message: '传输截断：流结束无终止事件', retryable: true, code: 'NETWORK', usage }
    },

    estimateUsage(src) {
      const measuredInput = src.measuredInputTokens ?? 0
      return {
        inputTokens: measuredInput > 0 ? measuredInput : estimateInputTokens(src.req, src.model),
        outputTokens: estimateOutputTokens(
          src.outText.join('') + src.outToolText.join('') + (src.pendingToolText ?? []).join(''),
          src.model,
        ),
        ...(src.cacheReadTokens !== undefined ? { cacheReadTokens: src.cacheReadTokens } : {}),
        ...(src.cacheWriteTokens !== undefined ? { cacheWriteTokens: src.cacheWriteTokens } : {}),
        estimated: true,
      }
    },
  }
}
