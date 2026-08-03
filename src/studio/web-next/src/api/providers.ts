import { apiJson } from './client'

// AI 服务供应商管理（应用级，跨书共享）

export type Protocol = 'anthropic' | 'openai'
export type AuthStrategy = 'anthropic' | 'claudeAuth' | 'bearer'

/** 服务级能力（连通/认证/流式）——供应商「测试连接」探测所得 */
export interface ProviderCaps {
  connected: boolean
  streaming: boolean
}

/** 模型级能力（tool_use/tool_choice）——选定模型后探测所得 */
export interface ModelCaps {
  toolUse: boolean
  toolChoice: boolean
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

export interface ProviderPreset {
  label: string
  hint: string
  protocol: Protocol
  auth: AuthStrategy
}

export async function getProviders(): Promise<{ providers: ProviderConfDto[]; currentId: string | null; currentModel: string | null; tiers: TierConfig }> {
  return apiJson('/api/providers')
}

export async function fetchModels(body: { protocol: Protocol; baseUrl: string; apiKey: string } | { id: string }): Promise<{ models: string[] }> {
  return apiJson('/api/providers/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function createProvider(body: {
  name: string
  protocol: Protocol
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
  body: { name: string; protocol: Protocol; baseUrl: string; apiKey: string },
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

export async function testProvider(id: string): Promise<TestResult> {
  return apiJson(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST' })
}

/** 设置全局当前模型（方案 A：model 独立于供应商，工作台选择）。
 *  选模型时后端自动探测模型级 caps（tool_use/tool_choice），随响应返回。 */
export async function setAiModel(model: string): Promise<{ ok: boolean; model: string; modelCaps?: ModelCaps | null; details?: string[] }> {
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
