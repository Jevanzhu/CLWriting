import { apiJson } from './client'

// AI 服务供应商管理（应用级，跨书共享）

// Responses 启用批（2026-08-17）：协议三选一（openai-responses 曾随 Z-P2-1 误判停用）
export type Protocol = 'anthropic' | 'openai' | 'openai-responses'
export type AuthStrategy = 'anthropic' | 'claudeAuth' | 'bearer'

/** 服务级能力（连通/认证/流式）——供应商「测试连接」探测所得 */
export interface ProviderCaps {
  connected: boolean
  streaming: boolean
}

/** 推理等级档位（与 reasoning_effort API 参数对齐） */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 任务档位槽——模型 + 推理等级 + 可选超时（P10，ms） */
export interface TierSlot {
  model: string
  effort: EffortLevel
  timeoutMs?: number
}

/** 任务档位配置（应用级，存 providers.json） */
export interface TierConfig {
  creative: TierSlot
  assistant: TierSlot | null
  chat: TierSlot | null
}

/**
 * 模型行（P9 §7.1 对齐 DSH 四字段）——id 必填 / name 可选 + 行展开 contextWindow / maxTokens。
 * 行结构开放：未知字段服务端原样存盘（DSH 教训），前端仅编辑声明的字段。
 */
export interface ModelConfDto {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  [key: string]: unknown
}

export interface ProviderConfDto {
  id: string
  name: string
  protocol: Protocol
  auth?: AuthStrategy
  baseUrl: string
  model?: string // 方案 A：model 移至全局，供应商不再绑死
  apiKey: string // 返回时为空串（不回传原始 key）
  apiKeyMasked: string
  models?: ModelConfDto[]
  caps: ProviderCaps | null
  capsProbedAt?: number
  sortIndex?: number
}

export interface ProvidersResponse {
  providers: ProviderConfDto[]
  currentId: string | null
  currentModel: string | null
  tiers: TierConfig
  /** 并发修订号（P4）：写端点 expectedRevision 依据 */
  revision: number
}

export async function getProviders(): Promise<ProvidersResponse> {
  return apiJson('/api/providers')
}

export async function fetchModels(body: { protocol: Protocol; baseUrl: string; apiKey: string } | { id: string }): Promise<{ models: string[] }> {
  return apiJson('/api/providers/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 30_000) // 拉模型列表可能慢，30s 超时
}

export async function createProvider(body: {
  name: string
  protocol: Protocol
  auth?: AuthStrategy
  baseUrl: string
  apiKey: string
  models?: ModelConfDto[]
  expectedRevision?: number
}): Promise<{ provider: ProviderConfDto; revision: number }> {
  return apiJson('/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function updateProvider(
  id: string,
  body: { name: string; protocol: Protocol; auth?: AuthStrategy; baseUrl: string; apiKey: string; models?: ModelConfDto[]; expectedRevision?: number },
): Promise<{ provider: ProviderConfDto; revision: number }> {
  return apiJson(`/api/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteProvider(id: string, expectedRevision?: number): Promise<{ ok: boolean; currentId: string | null; revision: number }> {
  return apiJson(`/api/providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: expectedRevision !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: expectedRevision !== undefined ? JSON.stringify({ expectedRevision }) : undefined,
  })
}

export async function setCurrentProvider(id: string, expectedRevision?: number): Promise<{ ok: boolean; currentId: string | null; revision?: number }> {
  return apiJson('/api/providers/current', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, expectedRevision }),
  })
}

export interface TestResult {
  ok: boolean
  caps?: ProviderCaps
  details?: string[]
  error?: string
  /** 探测写回会 bump 服务端 revision——回传供前端 test() 同步（P4 竞态：否则测试后任意写 409） */
  revision?: number
}

export async function testProvider(id: string, model?: string): Promise<TestResult> {
  return apiJson(`/api/providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(model ? { model } : {}),
  }, 60_000)
}

/** 更新任务档位配置（D 档：创作档/助手档） */
export async function setTiers(body: { creative: TierSlot; assistant: TierSlot | null; expectedRevision?: number }): Promise<{ ok: boolean; tiers: TierConfig; revision: number; details?: Record<string, string[]> }> {
  return apiJson('/api/tiers', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 更新对话档位（单档端点，不碰 creative/assistant/currentModel；null = 清除回落创作档） */
export async function setChatTier(slot: TierSlot | null, expectedRevision?: number): Promise<{ ok: boolean; tiers: TierConfig; revision: number }> {
  const body = slot
    ? { ...slot, expectedRevision }
    : (expectedRevision !== undefined ? { clear: true, expectedRevision } : null)
  return apiJson('/api/tiers/chat', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── RAG（嵌入）服务商管理（应用级，跨书共享；书在 book.yaml rag.provider 引用） ──

export interface RagProviderCaps {
  connected: boolean
}

export interface RagProviderDto {
  id: string
  name: string
  endpoint: string // embeddings 完整 URL（OpenAI 兼容 POST 端点）
  model: string
  apiKey: string // 返回时为空串（不回传原始 key）
  apiKeyMasked: string
  caps: RagProviderCaps | null
  capsProbedAt?: number
  sortIndex?: number
}

export interface RagProvidersResponse {
  ragProviders: RagProviderDto[]
  revision: number
}

export async function getRagProviders(): Promise<RagProvidersResponse> {
  return apiJson('/api/rag-providers')
}

export async function createRagProvider(body: {
  name: string
  endpoint: string
  model: string
  apiKey: string
  expectedRevision?: number
}): Promise<{ provider: RagProviderDto; revision: number }> {
  return apiJson('/api/rag-providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 编辑：apiKey 留空 = 保留原 key；endpoint/model 变更后服务端清 caps 要求重测 */
export async function updateRagProvider(
  id: string,
  body: { name: string; endpoint: string; model: string; apiKey: string; expectedRevision?: number },
): Promise<{ provider: RagProviderDto; revision: number }> {
  return apiJson(`/api/rag-providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 删除不级联改书：引用它的书此后解析为「未配置」（「设置 · 本书」页提示重选） */
export async function deleteRagProvider(id: string, expectedRevision?: number): Promise<{ ok: boolean; revision: number }> {
  return apiJson(`/api/rag-providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: expectedRevision !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: expectedRevision !== undefined ? JSON.stringify({ expectedRevision }) : undefined,
  })
}

export interface RagTestResult {
  ok: boolean
  caps?: RagProviderCaps
  error?: string
}

/** 测试连接：真实 embed 一次 'ping'（15s） */
export async function testRagProvider(id: string): Promise<RagTestResult> {
  return apiJson(`/api/rag-providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }, 30_000)
}
