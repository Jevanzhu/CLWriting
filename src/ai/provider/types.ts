/**
 * Provider 抽象层类型定义（方案 §四①）。
 *
 * 协议×认证两维适配，双协议（Anthropic + OpenAI）。
 * GenRequest 极简——只含两种协议都稳定支持的参数。
 */

/** 协议类型——决定走哪种 SDK / 线格式 */
export type Protocol = 'anthropic' | 'openai'

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
  model?: string // 方案 A：model 移至全局（工作台选），供应商不再绑死
  apiKey: string // 存 userData（见 store.ts）
  caps: ProviderCaps | null // 服务级能力（连通/流式）；null = 尚未测试连接
  capsProbedAt?: number
  sortIndex?: number
  notes?: string
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

/** 模型级能力——tool_use / tool_choice（选定模型后探测，按 providerId+model 缓存） */
export interface ModelCaps {
  toolUse: boolean // 契约层依赖；false 则该模型不可用于写作
  toolChoice: boolean // 强制调用；false 则退回 prompt 引导 + 校验重试
}

/** 任务档位槽——模型 + 推理深度 + 单次输出上限（Q3 甲：端点按任务类型取档） */
export interface TierSlot {
  model: string
  effort: 'low' | 'medium' | 'high'
  maxTokens: number
  /** 整体超时上限 ms（B-2：档位可覆盖默认 10min）；缺省 → runner 默认值 */
  timeoutMs?: number
}

/** 任务档位配置（应用级，存 providers.json） */
export interface TierConfig {
  /** 创作档（写正文 / 改写 / 大纲 / 开书引导） */
  creative: TierSlot
  /** 助手档（三审 / 分析 / 检查）；null = 未配，回落 creative */
  assistant: TierSlot | null
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
  maxTokens: number
  tools?: ToolDef[]
  toolChoice?: 'auto' | 'any' | 'tool' // 配合 toolName
  toolName?: string // toolChoice='tool' 时指定
  stopSequences?: string[]
  /** 推理深度——适配器翻译为对应协议线格式 */
  effort?: 'low' | 'medium' | 'high'
}

export interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

export interface ToolDef {
  name: string
  description?: string
  input_schema: Record<string, unknown> // JSON Schema
}

/** 统一事件流——每次调用返回独立 async iterable */
export type GenEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'done'; usage: TokenUsage; stopReason: string }
  | { type: 'error'; message: string; retryable: boolean }

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/** Provider 接口——适配器实现 */
export interface ModelProvider {
  readonly conf: ProviderConf
  /** 模型级能力（tool_use / tool_choice）；null = 未探测，生成时保守降级 */
  readonly modelCaps: ModelCaps | null
  stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent>
}

/** 服务级探测结果（供应商「测试连接」） */
export interface ProbeResult {
  caps: ProviderCaps
  /** 探测过程中的诊断信息（不含书稿内容，不含完整 key） */
  details: string[]
}

/** 模型级探测结果（选定模型后触发） */
export interface ModelProbeResult {
  caps: ModelCaps
  details: string[]
}
