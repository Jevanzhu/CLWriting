/**
 * Provider 抽象层类型定义（方案 §四①）。
 *
 * 协议×认证两维适配，双协议（Anthropic + OpenAI）。
 * GenRequest 极简——只含两种协议都稳定支持的参数。
 */

/** 协议类型——决定走哪种 SDK / 线格式
 *  openai = Chat Completions（/v1/chat/completions）
 *  openai-responses = OpenAI Responses API（/v1/responses，gpt-5/grok 深度用）——
 *  曾随 Z-P2-1 误判停用（2026-08-17 作者澄清本意暂缓非不做），Responses 启用批回接 */
export type Protocol = 'anthropic' | 'openai' | 'openai-responses'

/**
 * 认证策略——与协议正交的独立维度。
 * 同为 anthropic 协议，官方用 x-api-key，中转服务只认 Bearer。
 */
export type AuthStrategy =
  | 'anthropic' // x-api-key + anthropic-version
  | 'claudeAuth' // 仅 Authorization: Bearer（Claude 中转服务）
  | 'bearer' // Authorization: Bearer（OpenAI 兼容端点）

/**
 * 供应商配置——用户在应用内添加/编辑的条目，不是硬编码注册表。
 *
 * CLWriting 是分发产品：每个用户接自己的服务，我们无法预知其端点。
 * caps 由「测试连接」实测探测写入，不靠假设。
 */
export interface ProviderConf {
  id: string
  name: string // 用户可读名称（「我的中转」「公司内网」）
  protocol: Protocol
  auth: AuthStrategy
  baseUrl: string
  model?: string // 方案 A：model 移至全局（工作台选），供应商不再绑死；运行时由 resolveProvider 注入实际档位模型
  apiKey: string // 存 userData（见 store.ts）
  /**
   * 模型行（P9 加性扩展，阶段 14 §7.1）——可选；缺省 = 无模型编辑器覆盖，行为与旧版完全一致。
   * 用于自定义网关：手写模型 + 行展开 contextWindow / maxTokens（K/M 输入），空值 = 回落 quirks 表/协议兜底。
   * 行结构开放：未知/未来字段原样存活，编辑不整行重建（DSH 教训）。
   */
  models?: ModelConf[]
  /** D2（批 5）：provider 级价格表（每百万 token 单价；models[].pricing 同键覆盖）。
   *  加性可选——未配置时一切行为与从前一致（cost 口径静默不生效）。 */
  pricing?: {
    inputPerMTok?: number
    outputPerMTok?: number
    cacheReadPerMTok?: number
    cacheWritePerMTok?: number
    currency?: string
  }
  caps: ProviderCaps | null // 服务级能力（连通/流式）；null = 尚未测试连接
  capsProbedAt?: number
  sortIndex?: number
  notes?: string
}

/** 模型行（阶段 14 §7.1）——P7 已拍板对齐 DSH 四字段：id / name + 行展开 contextWindow / maxTokens */
export interface ModelConf {
  id: string
  /** 显示名（选择器回落显示 id） */
  name?: string
  /** 上下文窗口（token）；缺省 = 未声明（消费者自取回落） */
  contextWindow?: number
  /** 单次输出上限（token）；缺省 = 未声明（回落 quirks.maxOutputTokens / 协议兜底） */
  maxTokens?: number
  /** D2（批 5）：模型级价格表（同名键覆盖 provider 级——同网关混挂不同价模型是现实场景） */
  pricing?: {
    inputPerMTok?: number
    outputPerMTok?: number
    cacheReadPerMTok?: number
    cacheWritePerMTok?: number
    currency?: string
  }
  /** 行结构开放：未知/未来字段原样存活（DSH 教训） */
  [key: string]: unknown
}

/**
 * RAG（嵌入）服务商配置——应用级多服务商，书里按 rag.provider 引用。
 *
 * 与 ProviderConf 同住 providers.json（key 共用 vault 加密），但结构独立：
 * 嵌入服务无协议/档位概念，caps 只测连通（embed 一次 'ping'）。
 */
export interface RagProviderConf {
  id: string // rag- 前缀（newRagProviderId），与 chat 服务商 id 不撞 vault 槽
  name: string
  /** embeddings 完整 URL（OpenAI 兼容 POST 端点，支持中转/自建） */
  endpoint: string
  /** 嵌入模型名 */
  model: string
  apiKey: string // 内存明文；落盘走 vault（同 ProviderConf.apiKey）
  caps: RagProviderCaps | null // null = 尚未测试连接
  capsProbedAt?: number
  sortIndex?: number
}

/** 嵌入服务商能力——只测连通（embed 调用成功即通过，无流式概念） */
export interface RagProviderCaps {
  connected: boolean
}

/** 应用级供应商设置（userDataPath/providers.json） */
export interface ProviderSettings {
  providers: ProviderConf[]
  currentId: string | null
}

/** 服务级能力——连通 / 认证 / 流式（供应商「测试连接」探测所得） */
export interface ProviderCaps {
  connected: boolean // 连通 + 认证（listModels 成功即算通过）
  streaming: boolean // 流式产出（逐字增量可用）
}

/** 推理等级档位（与 reasoning_effort API 参数对齐；并非所有模型都支持全部档位） */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 任务档位槽——模型 + 推理等级 + 单次输出上限（Q3 甲：端点按任务类型取档） */
export interface TierSlot {
  model: string
  effort: EffortLevel
  /** 整体超时上限 ms（B-2：档位可覆盖默认 10min）；缺省 → runner 默认值 */
  timeoutMs?: number
}

/** 任务档位配置（应用级，存 providers.json） */
export interface TierConfig {
  /** 创作档（写正文 / 改写 / 大纲 / 开书引导） */
  creative: TierSlot
  /** 助手档（三审 / 分析 / 检查）；null = 未配，回落 creative */
  assistant: TierSlot | null
  /** 对话档（对话助手）；null = 未配，回落 creative */
  chat: TierSlot | null
}

/**
 * 生成请求——协议无关，只含两种协议都稳定支持的参数。
 *
 * 刻意排除 temperature / top_p / top_k（新模型发则 400）、
 * cache_control（自动前缀缓存已够用）、output_config.format（网关静默忽略）。
 */
export interface GenRequest {
  systemPrompt: string
  messages: ChatMsg[]
  /** 单次输出上限——缺省则不限制（OpenAI）/ 兜底默认值（Anthropic API 必填） */
  maxTokens?: number
  tools?: ToolDef[]
  toolChoice?: 'auto' | 'any' | 'tool' // 配合 toolName
  toolName?: string // toolChoice='tool' 时指定
  /**
   * 工具型意图（表驱动重构 §5.3）：工作流层声明「必须产出工具调用」，
   * 由 generateTool 按模型系列表 toolChoiceMode 翻译为实际 tool_choice。
   * named → tool_choice 指名；required → 转 any（不能点名）；auto/none → 不发，prompt 引导。
   */
  requireTool?: boolean
  stopSequences?: string[]
  /** 推理等级——适配器翻译为对应协议线格式 */
  effort?: EffortLevel
  /**
   * 结构化输出（JSON Schema 驱动）——适配器翻译为对应协议线格式：
   * Anthropic → output_format.json_schema；OpenAI Responses → text.format；
   * OpenAI Chat Completions → response_format。非 400 兼容端点自动降级。
   */
  structured?: { schema: Record<string, unknown> }
}

export interface ChatMsg {
  role: 'user' | 'assistant'
  /**
   * 纯文本（现有 7 个端点全走这条，零改动）或 content block 数组（含 tool_use/tool_result 往返）。
   * 适配器入口用 `typeof content === 'string'` 快路，向后兼容。
   */
  content: string | ContentBlock[]
}

/**
 * Content block——中立表示（Anthropic 风格，表达力更强；OpenAI 侧由适配器展开还原）。
 * 对话助手 agent 循环的 tool_use/tool_result 往返用。
 *
 * reasoning：模型思维链（DeepSeek/Kimi 思考模型的 reasoning_content）。
 * 多轮带 tools 时 assistant 消息必须完整回传 reasoning_content，否则 DeepSeek/Kimi 400
 * （方案 §4.2）。Anthropic 原生端点无此回传要求，收到即静默丢弃。
 *
 * encrypted/itemId（Responses 线缺口 11）：OpenAI store:false + 工具调用场景的
 * 加密推理项载体——reasoning_item 事件收集入 GenResult，chat.ts 组装 assistant 轮
 * 带上，适配器下轮回插 input 维持推理状态；Chat/Anthropic 线恒 undefined。
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; encrypted?: string; itemId?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export interface ToolDef {
  name: string
  description?: string
  input_schema: Record<string, unknown> // JSON Schema
}

/** 统一事件流——每次调用返回独立 async iterable */
export type GenEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  /**
   * 加密推理项透出（Responses 线缺口 11）：output_item.done(reasoning, encrypted_content)
   * → 适配器发出 → gen 收集入 GenResult → orchestrate 存回 assistant 消息 reasoning 块，
   * 下轮请求回插 input 维持多轮工具调用的推理延续。Chat/Anthropic 线不发此事件。
   */
  | { type: 'reasoning_item'; encrypted: string; itemId?: string }
  | { type: 'tool'; id: string; name: string; input: unknown }
  /**
   * Q-13（第十五轮）：适配器 resolve 后实际上线的输出上限（req.maxTokens → 模型行 →
   * quirks 表 → 协议兜底的终值；openai/responses 线无兜底不发时 undefined）——随 done
   * 事件透出，gen 层收集入 GenResult，最终落 llm/call（铁律②重放口径）。early-error
   * 路径无 done → 无值
   */
  | {
      type: 'done'
      usage: TokenUsage
      stopReason: string
      resolvedMaxTokens?: number
      /** Z-12（第五十八轮）：本次成功建流用的是降级参数面（剥 structured/剥 tools）——
       *  适配器降级循环实际发送的参数面与首发不同，不落事件则按事件重放会再 400 */
      degraded?: boolean
    }
  | {
      type: 'error'
      message: string
      retryable: boolean
      /** A5（DSH-15 LlmFailure 对标）：结构化错误码——决策表 failureAction 的输入 */
      code?: GenErrorCode
      /** HTTP 状态码（协议层错误才有） */
      status?: number
      /** 服务端 Retry-After（毫秒；B4 退避升级时消费） */
      retryAfterMs?: number
      /** 服务端请求 id（OpenAI 兼容 x-request-id / Anthropic request-id，排障用） */
      requestId?: string
      /** B-12/R31-1（三十一轮）：网关已返回 usage 的终态失败（如传输截断前已收到
       *  usage chunk）随错上抛——gen 层装入 GenError.usage，runner 终态失败按
       *  B-12 通道按真实消耗入账，截断不丢计费 */
      usage?: TokenUsage
    }

/**
 * 结构化错误码（A5）。处置决策表见 provider/failure.ts 的 failureAction：
 * 可重试（RATE_LIMIT/SERVER_ERROR/TIMEOUT/NETWORK）/ 换 provider（AUTH/NOT_FOUND/UNSUPPORTED）/
 * 改提示词（CONTEXT_WINDOW_EXCEEDED → 触发压缩裁剪）/ 交作者（BAD_REQUEST/PROTOCOL/UNKNOWN）。
 */
export type GenErrorCode =
  | 'RATE_LIMIT' // 429
  | 'SERVER_ERROR' // 5xx
  | 'TIMEOUT' // 首字节/流超时（B-2）
  | 'NETWORK' // 连接层失败（SDK APIConnectionError）
  | 'AUTH' // 401/402/403：key 无效 / 无权限 / 欠费
  | 'NOT_FOUND' // 404：模型/端点不存在
  | 'CONTEXT_WINDOW_EXCEEDED' // 输入超窗（400 文案启发）
  | 'MAX_TOKENS' // 输出截断（结构化场景不可用）
  | 'UNSUPPORTED' // 模型能力不支持（如无 tool_use）
  | 'ABORTED' // 主动中断
  | 'BAD_REQUEST' // 400 其他（多半是请求组装问题）
  | 'PROTOCOL' // 协议/解析层异常
  | 'UNKNOWN'

/**
 * 统一 token 用量（批次 D4 补 cache 记账，学 cherry TokenUsage 三分）。
 *
 * inputTokens 口径已归一（M-1）：**不含** cache 命中读量——OpenAI 兼容线
 * （Chat/Responses）的 prompt_tokens/input_tokens 原本已含 cached_tokens，
 * 适配器边界处扣减（归一成 Anthropic 语义）；Anthropic 线天然不含，直传。
 * 由此 computeCallCost 四档分计与预算 token 合计（input+output+cacheRead+cacheWrite）
 * 对两协议同时成立，不再双计 OpenAI 的 cache 命中部分。
 * cacheWriteTokens 仅 Anthropic 协议有值（OpenAI 兼容线无此概念）。
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** 前缀缓存命中读量（独立于 inputTokens 记账，两协议同口径） */
  cacheReadTokens?: number
  /** 前缀缓存写入量（仅 Anthropic 协议下发） */
  cacheWriteTokens?: number
  /** 推理 token 消耗量（Responses 线 usage.output_tokens_details.reasoning_tokens，缺口 8 校准源；已含于 outputTokens） */
  reasoningTokens?: number
  /**
   * R73-1（二十一轮 A-1）：估计入账标记——网关完成生成（有 finish_reason/stop_reason）
   * 但不回 usage 事件时，input/output 为按库内估算系数（estimateTokens 同源）折算的
   * 估计值而非端点下发值。记账/预算闸按数值照常生效（修复前按 0/0 入账，预算闸对
   * 这类端点永不生效）；成本报表消费方可据此区分实测与估计口径。
   */
  estimated?: boolean
}

/** Provider 接口——适配器实现 */
export interface ModelProvider {
  readonly conf: ProviderConf
  stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent>
}

/** 服务级探测结果（供应商「测试连接」） */
export interface ProbeResult {
  caps: ProviderCaps
  /** 探测过程中的诊断信息（不含书稿内容，不含完整 key） */
  details: string[]
}
