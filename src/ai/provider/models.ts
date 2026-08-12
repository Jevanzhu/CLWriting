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
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { Protocol } from './types.js'

/**
 * 归一化 baseUrl（方案 §4.5 P0，openai/chat 与 anthropic 行为不同）：
 * - openai（含 openai-responses）：**只去尾部斜杠**，不剥 /v1——openai SDK 不自拼 /v1，
 *   剥了官方端点反而 404（models.list 会打 {base}/models）
 * - anthropic：去尾斜杠 + 剥尾部 /v1——anthropic SDK 自拼 /v1/messages，防 /v1/v1
 */
function normalizeBaseUrl(baseUrl: string, protocol: Protocol): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return protocol === 'anthropic' ? trimmed.replace(/\/v1$/, '') : trimmed
}

export async function listModels(protocol: Protocol, baseUrl: string, apiKey: string): Promise<string[]> {
  // mock 环境短路（CLWRITING_DRIVER=mock）——避免向不存在端点发真实请求导致 fetchModels 超时
  if (process.env['CLWRITING_DRIVER'] === 'mock') {
    return ['gpt-4o', 'gpt-4o-mini']
  }
  const url = normalizeBaseUrl(baseUrl, protocol)
  if (protocol === 'anthropic') {
    // 先试 /v1/models（网关兼容），失败回退空列表（官方无此端点，模型名手动输入）
    try {
      const client = new Anthropic({
        baseURL: url,
        apiKey,
        defaultHeaders: { Authorization: `Bearer ${apiKey}` },
      })
      const list = await client.models.list()
      return list.data.map((m) => m.id).sort()
    } catch {
      return []
    }
  }
  const client = new OpenAI({ baseURL: url, apiKey })
  const list = await client.models.list()
  return list.data.map((m) => m.id).sort()
}
