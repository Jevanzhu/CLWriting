/**
 * 三适配器公共错误处理（hh 评审 §八 条目 9：消除三份同构拷贝）。
 *
 * 两个公共面：
 * - makeToErrorEvent：SDK 异常 → GenEvent.error 的五分支工厂。两家 SDK（@anthropic-ai/sdk
 *   / openai）的 APIError 家族同构但类挂在各自命名空间下、无公共基类——工厂以构造函数
 *   签名传参（instanceof 判定用），不 import 具体 SDK，适配器只贴 label。
 * - 400 降级链：buildDegradeAttempts（attempts 构造）+ isMidChain400（continue 语义）+
 *   markStructuredDegrade（降级记忆写入）。三适配器的降级链此前是三份逐字节同构的拷贝。
 *
 * status → code 的决策表在 failure.ts（httpStatusToCode / headerErrorFields），
 * 本模块是适配器侧的组合层，不重复决策逻辑。
 */
import type { GenEvent, GenRequest, ProviderConf } from './types.js'
import type { ProviderStore } from './store.js'
import { persistDegraded, lookupDegraded } from './store.js'
import { redactSecret } from './redact.js'
import { httpStatusToCode, headerErrorFields } from './failure.js'

/**
 * toErrorEvent 分支判定/字段提取所需的最小 SDK 错误面。
 * 两家 SDK 的 APIError<TStatus, THeaders, TError> 字段同构（status/headers/requestID），
 * 取其交集；headers 形态（Headers 实例 / plain object）由 headerErrorFields 兼容。
 */
interface SdkApiError {
  readonly status: number | undefined
  readonly headers: unknown
  readonly requestID: string | null | undefined
  readonly message: string
}

/** instanceof 判定用的构造函数类型（abstract：只判不构造；never 参数位匹配任意 SDK 构造签名） */
type SdkErrorCtor = abstract new (...args: never[]) => SdkApiError

/**
 * SDK 异常 → GenEvent.error 工厂（三适配器 toErrorEvent 的单一实现）。
 *
 * 五分支次序不可调换：APIUserAbortError / APIConnectionError 都是 APIError 的子类
 * （status undefined），必须在通用 APIError 分支前判定，否则用户中断被误报
 * 「<label> undefined: Request was aborted」、连接失败被归 UNKNOWN。
 */
export function makeToErrorEvent(ctors: {
  APIError: SdkErrorCtor
  APIUserAbortError: SdkErrorCtor
  APIConnectionError: SdkErrorCtor
  /** 错误 message 前缀（'Anthropic API' / 'OpenAI API'），保持各线原有文案 */
  label: string
}): (e: unknown) => GenEvent {
  const { APIError, APIUserAbortError, APIConnectionError, label } = ctors
  return (e: unknown): GenEvent => {
    if (e instanceof APIUserAbortError) {
      return { type: 'error', message: '已中断', retryable: false, code: 'ABORTED' }
    }
    // 连接层失败（含 APIConnectionTimeoutError）单列——status undefined 的 APIError（A5）
    // Y-14（第五十七轮）：retryable 布尔与 failure.ts 决策表对齐（NETWORK → 'retry'）——
    // 此前 false 全靠 code 决策表兜住实际重试，若落到布尔兜底分支（mode:'always'）
    // 连接类错误的可重试性会静默翻转
    if (e instanceof APIConnectionError) {
      return { type: 'error', message: redactSecret(e.message), retryable: true, code: 'NETWORK' }
    }
    if (e instanceof APIError) {
      const retryable = e.status === 429 || (e.status ?? 0) >= 500
      return {
        type: 'error',
        message: redactSecret(`${label} ${e.status}: ${e.message}`),
        retryable,
        code: httpStatusToCode(e.status, e.message),
        ...(e.status !== undefined ? { status: e.status } : {}),
        ...headerErrorFields(e.headers),
        ...(e.requestID ? { requestId: e.requestID } : {}),
      }
    }
    // SDK 外层抛的 DOM AbortError（signal 触发时 fetch 侧的形态，非 SDK 包装）
    if (e instanceof Error && e.name === 'AbortError') {
      return { type: 'error', message: '已中断', retryable: false, code: 'ABORTED' }
    }
    const msg = e instanceof Error ? e.message : String(e)
    return { type: 'error', message: redactSecret(msg), retryable: false, code: 'PROTOCOL' }
  }
}

/** 降级链执行计划（buildDegradeAttempts 输出；isMidChain400 / markStructuredDegrade 消费） */
export interface DegradePlan {
  /** 依序尝试的参数面（降级记忆命中时跳过首发原样请求） */
  attempts: GenRequest[]
  /** 剥 structured 参数面对象——降级记忆写入判据（建流成功的 attempt === 此对象） */
  stripStructured: GenRequest | null
  /** 记忆键（conf.id/model）；未选模型时 null（无处写记忆） */
  degradedKey: string | null
  /** A3（五十九轮）：首发原始请求——降级判定基准。记忆命中时 attempts[0] 已是剥除版，
   *  「attempt !== attempts[0]」对首发恒 false 会漏标 degraded（Z-12 重放口径缺口在
   *  记忆命中路径——常态——全部漏标）；适配器改判 attempt !== original，无论首发是否
   *  被记忆剥除，成功建流只要非原始参数面即标降级 */
  original: GenRequest
}

/**
 * 400 降级链 attempts 构造（方案 §6.5，三适配器共用）。
 *
 * 表驱动后首发即正确，链上只留「中转怪癖」兜底：structured（json_schema/json_object
 * 网关兼容性最参差）剥除重试一级，末端再挂「剥 tools → 纯文本」一环（unknown 系列
 * 若实际不支持工具调用，纯 tools 请求 400 后不再同形状反复重试到放弃）。
 * effort 不入链（表已保证该发的才发）。降级命中 → 写记忆（providers.json 复用原
 * modelCaps 槽），下次首发即剥。
 *
 * 连接期异常（建流 create 抛出、尚未消费任何 chunk）可安全换参数面重试；
 * 流中异常（已开始消费）不重跑——半截产出泄入下一 attempt 会污染拼装 / 重复增量。
 * 结构保证双轨（ii-1）：anthropic 消费循环在 attempts 循环外（天然不重跑）；
 * openai / responses 消费循环在 attempt 内，由适配器 catch 的 consumedAny 守卫
 * （收到首个 chunk 后 isMidChain400 不再放行续跑）。
 */
export function buildDegradeAttempts(
  req: GenRequest,
  structuredMode: 'json_schema' | 'json_object' | 'none',
  conf: Pick<ProviderConf, 'id' | 'model'>,
  store: ProviderStore | undefined,
): DegradePlan {
  const degradedKey = conf.id && conf.model ? `${conf.id}/${conf.model}` : null
  // 优先 lookupDegraded 新鲜读（适配器实例缓存后，捕获 store 是创建时快照，会读到旧记忆，D2）；
  // 未注册查通道（单测直连适配器）→ 回落捕获 store 快照
  const degraded = degradedKey
    ? (lookupDegraded(degradedKey) ?? (store?.modelCaps?.[degradedKey] ? true : undefined))
    : undefined
  const stripStructured =
    req.structured && structuredMode !== 'none' ? ({ ...req, structured: undefined } as GenRequest) : null
  const stripTools = req.tools?.length
    ? ({ ...req, tools: undefined, toolChoice: undefined, toolName: undefined } as GenRequest)
    : null
  let attempts: GenRequest[]
  if (stripStructured && stripTools) {
    // 记忆命中 → 首发即用剥除版（否则记忆反而关闭降级链、structured 照发 → 必败）
    attempts = degraded ? [stripStructured, stripTools] : [req, stripStructured, stripTools]
  } else if (stripStructured) {
    attempts = degraded ? [stripStructured] : [req, stripStructured]
  } else if (stripTools) {
    attempts = [req, stripTools]
  } else {
    attempts = [req]
  }
  return { attempts, stripStructured, degradedKey, original: req }
}

/**
 * 非最后 attempt 的 400 → continue 语义（降级链的续跑闸）。
 * 最后一个 400 必须透传原文——否则真实参数错误被降级链的兜底文案掩盖。
 */
export function isMidChain400(e: unknown, APIError: SdkErrorCtor, attempt: GenRequest, plan: DegradePlan): boolean {
  return e instanceof APIError && e.status === 400 && attempt !== plan.attempts[plan.attempts.length - 1]
}

/**
 * 降级记忆写入：仅当「剥 structured 的重试」建流成功才落盘（防任意 400 误归因污染记忆）；
 * 剥 tools 的 attempt 不写 structured 记忆（归因不同，防污染）。
 * 落盘走 persistDegraded 通道（不依赖捕获 store），store 快照有则同步双写（D2）。
 */
export function markStructuredDegrade(plan: DegradePlan, attempt: GenRequest, store: ProviderStore | undefined): void {
  if (plan.degradedKey && attempt === plan.stripStructured) {
    if (store) store.modelCaps[plan.degradedKey] = { structured: false }
    persistDegraded(plan.degradedKey)
  }
}
