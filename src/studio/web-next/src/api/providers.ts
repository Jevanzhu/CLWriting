import { apiJson } from './client'

// AI 服务供应商管理（应用级，跨书共享）

export type Protocol = 'anthropic' | 'openai'
export type AuthStrategy = 'anthropic' | 'claudeAuth' | 'bearer'

export interface ProviderCaps {
  toolUse: boolean
  toolChoice: boolean
}

export interface ProviderConfDto {
  id: string
  name: string
  protocol: Protocol
  auth?: AuthStrategy
  baseUrl: string
  model: string
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

export async function getProviders(): Promise<{ providers: ProviderConfDto[]; currentId: string | null }> {
  return apiJson('/api/providers')
}

export async function createProvider(body: {
  name: string
  protocol: Protocol
  baseUrl: string
  model: string
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
  body: { name: string; protocol: Protocol; baseUrl: string; model: string; apiKey: string },
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
