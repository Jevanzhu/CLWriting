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

/** 任务档位槽——模型 + 推理等级 */
export interface TierSlot {
  model: string
  effort: EffortLevel
}

/** 任务档位配置（应用级，存 providers.json） */
export interface TierConfig {
  creative: TierSlot
  assistant: TierSlot | null
  chat: TierSlot | null
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
  caps: ProviderCaps | null
  capsProbedAt?: number
  sortIndex?: number
}

export async function getProviders(): Promise<{ providers: ProviderConfDto[]; currentId: string | null; currentModel: string | null; tiers: TierConfig }> {
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
}): Promise<{ provider: ProviderConfDto }> {
  return apiJson('/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function updateProvider(
  id: string,
  body: { name: string; protocol: Protocol; auth?: AuthStrategy; baseUrl: string; apiKey: string },
): Promise<{ provider: ProviderConfDto }> {
  return apiJson(`/api/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteProvider(id: string): Promise<{ ok: boolean; currentId: string | null }> {
  return apiJson(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function setCurrentProvider(id: string): Promise<{ ok: boolean; currentId: string | null }> {
  return apiJson('/api/providers/current', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
}

export interface TestResult {
  ok: boolean
  caps?: ProviderCaps
  details?: string[]
  error?: string
}

export async function testProvider(id: string, model?: string): Promise<TestResult> {
  return apiJson(`/api/providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(model ? { model } : {}),
  }, 60_000)
}

/** 设置全局当前模型（方案 A：model 独立于供应商，工作台选择）。
 *  表驱动重构（§6.3）：模型能力不再探测——静态表判定；响应仅携带降级记忆（structured 支持状态）。 */
export async function setAiModel(model: string): Promise<{ ok: boolean; model: string; modelCaps?: { structured: false } | null; details?: unknown }> {
  return apiJson('/api/ai-model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
}

/** 更新任务档位配置（D 档：创作档/助手档） */
export async function setTiers(body: { creative: TierSlot; assistant: TierSlot | null }): Promise<{ ok: boolean; tiers: TierConfig; details?: Record<string, string[]> }> {
  return apiJson('/api/tiers', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 更新对话档位（单档端点，不碰 creative/assistant/currentModel；null = 清除回落创作档） */
export async function setChatTier(slot: TierSlot | null): Promise<{ ok: boolean; tiers: TierConfig }> {
  return apiJson('/api/tiers/chat', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slot),
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

export async function getRagProviders(): Promise<{ ragProviders: RagProviderDto[] }> {
  return apiJson('/api/rag-providers')
}

export async function createRagProvider(body: {
  name: string
  endpoint: string
  model: string
  apiKey: string
}): Promise<{ provider: RagProviderDto }> {
  return apiJson('/api/rag-providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 编辑：apiKey 留空 = 保留原 key；endpoint/model 变更后服务端清 caps 要求重测 */
export async function updateRagProvider(
  id: string,
  body: { name: string; endpoint: string; model: string; apiKey: string },
): Promise<{ provider: RagProviderDto }> {
  return apiJson(`/api/rag-providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 删除不级联改书：引用它的书此后解析为「未配置」（AI 功能页提示重选） */
export async function deleteRagProvider(id: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/rag-providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
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
