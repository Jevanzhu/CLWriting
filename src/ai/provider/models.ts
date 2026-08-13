/**
 * 模型列表获取——调供应商 API 拉模型列表。
 *
 * 协议差异（重要）：
 * - OpenAI 兼容：GET {baseURL}/models（openai SDK 不自拼 /v1，基址须自带版本路径）
 * - Anthropic 官方：**没有** /v1/models 端点（SDK 的 models.list 打官方是 404）
 *   · 中转网关多数支持 GET {baseURL}/v1/models → 优先试
 *   · 官方 / 纯官方格式 → 无法枚举，回退 fallback（空列表，调用方手动输入模型名）
 *   · 网关也不支持 /models → 404/405，同样回退
 */
import Anthropic, { APIError } from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { Protocol, AuthStrategy } from './types.js'

/**
 * 归一化 baseUrl（方案 §4.5 P0，openai/chat 与 anthropic 行为不同）：
 * - openai（含 openai-responses）：**只去尾部斜杠**，不剥 /v1——openai SDK 不自拼 /v1，
 *   剥了官方端点反而 404（models.list 会打 {base}/models）
 * - anthropic：去尾斜杠 + 剥尾部 /v1——anthropic SDK 自拼 /v1/messages，防 /v1/v1
 */
export function normalizeBaseUrl(baseUrl: string, protocol: Protocol): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return protocol === 'anthropic' ? trimmed.replace(/\/v1$/, '') : trimmed
}

/**
 * Anthropic 客户端构造参数（auth 策略 + env 污染阻断）——导出供单测断言。
 *
 * 关键：auth='anthropic' 时显式 authToken:null，阻断环境变量 ANTHROPIC_AUTH_TOKEN
 * 注入（SDK 只在 authToken === undefined 时读 env）。本机 Claude Code 凭据会污染成
 * 双认证头，网关只认 authorization → 返回匿名子集 2 个模型（模型列表只有 2 个的根因）。
 */
export function anthropicClientOpts(
  url: string,
  apiKey: string,
  auth: AuthStrategy = 'anthropic',
): ConstructorParameters<typeof Anthropic>[0] {
  const opts: ConstructorParameters<typeof Anthropic>[0] = {
    baseURL: url,
    defaultHeaders: { 'anthropic-version': '2023-06-01' },
    authToken: null,
  }
  if (auth === 'anthropic') {
    opts.apiKey = apiKey
  } else {
    // claudeAuth / bearer：authToken 只发 Authorization: Bearer
    opts.authToken = apiKey
  }
  return opts
}

export async function listModels(
  protocol: Protocol,
  baseUrl: string,
  apiKey: string,
  auth: AuthStrategy = 'anthropic',
): Promise<string[]> {
  // mock 环境短路（CLWRITING_DRIVER=mock）——避免向不存在端点发真实请求导致 fetchModels 超时
  if (process.env['CLWRITING_DRIVER'] === 'mock') {
    return ['gpt-4o', 'gpt-4o-mini']
  }
  const url = normalizeBaseUrl(baseUrl, protocol)
  if (protocol === 'anthropic') {
    // 按 auth 策略构造客户端（与 anthropic-adapter createClient 一致）
    const clientOpts = anthropicClientOpts(url, apiKey, auth)
    try {
      const client = new Anthropic(clientOpts)
      const list = await client.models.list()
      return list.data.map((m) => m.id).sort()
    } catch (e) {
      // 404/405 = 端点不存在（Anthropic 官方无 /v1/models）→ 回退空列表（模型名手动输入）
      if (e instanceof APIError && (e.status === 404 || e.status === 405)) return []
      // 401/403/网络错误等 → 上抛（调用方需区分「不通」与「通但认证错」）
      throw e
    }
  }
  const client = new OpenAI({ baseURL: url, apiKey })
  const list = await client.models.list()
  return list.data.map((m) => m.id).sort()
}
