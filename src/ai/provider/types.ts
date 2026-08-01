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
  model: string
  apiKey: string // 存 userData（见 store.ts）
  caps: ProviderCaps | null // null = 尚未探测
  capsProbedAt?: number
  sortIndex?: number
  notes?: string
}

/** 应用级供应商设置（userDataPath/providers.json） */
export interface ProviderSettings {
  providers: ProviderConf[]
  currentId: string | null
}

/** 能力矩阵——探测所得，驱动适配器和契约层的分支依据 */
export interface ProviderCaps {
  toolUse: boolean // 契约层依赖；false 则该供应商不可用于写作
  toolChoice: boolean // 强制调用；false 则退回 prompt 引导 + 校验重试
  streaming: boolean // 流式产出
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
  stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent>
}

/** 探测结果 */
export interface ProbeResult {
  caps: ProviderCaps
  /** 探测过程中的诊断信息（不含书稿内容，不含完整 key） */
  details: string[]
}
